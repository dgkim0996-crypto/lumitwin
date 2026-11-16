"""What-if 계획 시뮬레이션 실행기 테스트 (sim/lumisim/whatif.py, 브로커 없이 돈다).

실행: node scripts/sim.mjs --test
"""
from __future__ import annotations

import copy
import unittest

from lumisim import whatif as W
from lumisim.engine import Sim

FACTORY = W._factory()
LINES = [ln['code'] for ln in FACTORY['lines']]
VARIANTS = {ln['code']: [v['code'] for v in ln['variants']] for ln in FACTORY['lines']}
HEALTH_ST = next(s['code'] for ln in FACTORY['lines'] for s in ln['stations'] if s.get('health'))
SCENARIO = FACTORY['scenarios'][0]['id']


def base(**kw) -> dict:
    b = {
        'source': 'live', 'startAt': '2026-11-16T00:00:00.000Z',
        'lines': {code: {'variant': None, 'orders': []} for code in LINES}, 'notes': [],
    }
    b.update(kw)
    return b


def plan(orders: dict | None = None, events: list | None = None, auto_fill: bool = True) -> dict:
    o = {code: [] for code in LINES}
    o.update(orders or {})
    return {'orders': o, 'events': events or [], 'autoFill': auto_fill}


def inp(scenarios: list[dict], hours: float = 2.0, reps: int = 1, seed: int = 21, b: dict | None = None, workers: int = 1) -> dict:
    return {'horizonSec': hours * 3600, 'reps': reps, 'seed': seed, 'workers': workers, 'base': b or base(), 'scenarios': scenarios}


def run(i: dict) -> list[dict]:
    return W.run_all(i, progress=lambda _x: None)


def strip(runs: list[dict]) -> list[dict]:
    out = copy.deepcopy(runs)
    for r in out:
        r.pop('wallMs', None)
    return out


def order(runs: list[dict], line: str, wid: int) -> dict:
    return next(o for o in runs[0]['orders'] if o['line'] == line and o['id'] == wid)


class WhatIf(unittest.TestCase):
    def test_same_input_same_result(self):
        """같은 입력이면 같은 결과 (공통 난수 비교의 전제)"""
        i = inp([plan()], hours=1.5)
        self.assertEqual(strip(run(i)), strip(run(i)))

    def test_parallel_equals_sequential(self):
        """여러 프로세스로 돌려도 반복별 결과는 같다"""
        i = inp([plan(), plan(events=[{'kind': 'down', 'station': 'HL-AS-01', 'atMin': 10, 'minutes': 30}])], hours=1.0, reps=2)
        seq = strip(run(i))
        par = strip(run(dict(i, workers=2)))
        self.assertEqual(seq, par)

    def test_output_shape(self):
        runs = run(inp([plan()], hours=2.5))
        r = runs[0]
        self.assertEqual((r['scenario'], r['rep'], r['seed']), (0, 0, 21))
        for code in LINES:
            h = r['lines'][code]['hourly']
            self.assertEqual(len(h), 3)
            self.assertEqual(h, sorted(h))
            self.assertEqual(h[-1], r['lines'][code]['out'])
        self.assertIn('wearEnd', r['stations'][HEALTH_ST])

    def test_plan_queue_and_stop_without_autofill(self):
        """계획 큐대로 투입하고, autoFill이 꺼지면 계획이 바닥난 뒤 투입을 멈춘다. 지시는 순서대로 끝난다"""
        l, r = VARIANTS['HL'][0], VARIANTS['HL'][1]
        runs = run(inp([plan({'HL': [
            {'id': 11, 'code': 'WO-11', 'variant': r, 'qty': 12, 'released': 0},
            {'id': 12, 'code': 'WO-12', 'variant': l, 'qty': 12, 'released': 0},
        ]}, auto_fill=False)], hours=3.0))
        a, b = order(runs, 'HL', 11), order(runs, 'HL', 12)
        self.assertEqual((a['released'], b['released']), (12, 12))
        self.assertIsNotNone(a['finishedSec'])
        self.assertIsNotNone(b['finishedSec'])
        self.assertLess(a['finishedSec'], b['finishedSec'])
        self.assertEqual(a['done'] + a['scrap'], 12)
        self.assertFalse([o for o in runs[0]['orders'] if o['line'] == 'HL' and o['id'] < 0])
        self.assertEqual(runs[0]['lines']['HL']['changeovers'], 1)

    def test_autofill_after_plan(self):
        """autoFill이면 계획 뒤를 자동 계획 지시(음수 id)로 채운다: 마지막 기종의 다음 기종부터"""
        v0, v1 = VARIANTS['OSM'][0], VARIANTS['OSM'][1]
        runs = run(inp([plan({'OSM': [{'id': 5, 'code': 'WO-5', 'variant': v0, 'qty': 10, 'released': 0}]})], hours=1.0))
        auto = [o for o in runs[0]['orders'] if o['line'] == 'OSM' and o['id'] < 0]
        self.assertTrue(auto)
        self.assertEqual(auto[0]['code'], 'AUTO-OSM-1')
        self.assertEqual(auto[0]['variant'], v1)

    def test_running_order_continues(self):
        """기준 시각에 투입 중이던 지시는 이미 투입한 수부터 이어 간다. 제품 경로 재공은 그 지시 몫으로 센다"""
        v = VARIANTS['HL'][0]
        b = base(lines={**base()['lines'], 'HL': {'variant': v, 'orders': [
            {'id': 7, 'code': 'WO-7', 'variant': v, 'qty': 20, 'status': 'RUNNING', 'released': 15, 'done': 9}]}},
            buffers={'HL.EOL': 2})
        runs = run(inp([plan({'HL': [{'id': 7, 'code': 'WO-7', 'variant': v, 'qty': 20, 'released': 15}]}, auto_fill=False)], hours=2.0, b=b))
        o = order(runs, 'HL', 7)
        self.assertEqual(o['released'], 20)
        self.assertIsNotNone(o['finishedSec'])
        # 기준 완성 9 + 재공 2 + 새로 투입한 5 (폐기가 있으면 그만큼 적다)
        self.assertEqual(o['done'] + o['scrap'], 9 + 2 + 5)
        self.assertEqual(runs[0]['lines']['HL']['changeovers'], 0)

    def test_down_event_costs_output(self):
        """같은 씨앗에서 조립 설비를 2시간 세우면 헤드램프 양품이 줄고, 그 설비의 고장 시간이 2시간 넘게 쌓인다"""
        runs = run(inp([plan(), plan(events=[{'kind': 'down', 'station': 'HL-AS-01', 'atMin': 30, 'minutes': 120}])], hours=4.0))
        base_out = runs[0]['lines']['HL']['out']
        down_out = runs[1]['lines']['HL']['out']
        self.assertLess(down_out, base_out - 50)
        self.assertGreaterEqual(runs[1]['stations']['HL-AS-01']['sec'].get('DOWN', 0), 7200 - 1)
        self.assertGreaterEqual(runs[1]['stations']['HL-AS-01']['failures'], 1)

    def test_common_random_numbers_per_station(self):
        """설비별 난수 흐름: 헤드램프에만 고장을 넣으면 같은 씨앗에서 다른 라인 결과는 그대로다 (계획 차이 = 계획 탓)"""
        runs = run(inp([plan(), plan(events=[{'kind': 'down', 'station': 'HL-AS-01', 'atMin': 20, 'minutes': 40}])], hours=2.0))
        for code in LINES:
            if code == 'HL':
                continue
            self.assertEqual(runs[0]['lines'][code], runs[1]['lines'][code], code)
        self.assertNotEqual(runs[0]['lines']['HL']['out'], runs[1]['lines']['HL']['out'])

    def test_live_engine_keeps_shared_rng(self):
        """streams를 끈 기본 엔진(라이브·보정 실행)은 지금처럼 공장 공용 생성기를 쓴다"""
        sim = Sim(FACTORY, io=None, realtime=False, seed=3, tick=5.0)
        st = sim.stations['HL-AS-01']
        self.assertIs(st.rng, sim.rng)
        self.assertIs(st.xrng, sim.xrng)
        s2 = Sim(FACTORY, io=None, realtime=False, seed=3, tick=5.0, streams=True)
        self.assertIsNot(s2.stations['HL-AS-01'].rng, s2.rng)
        self.assertIsNot(s2.stations['HL-AS-01'].rng, s2.stations['HL-SL-01'].rng)

    def test_base_station_state_and_pm(self):
        """기준 상태: 고장 중 설비는 처음부터 서 있고(고장 횟수에는 안 센다), 마모를 넣은 설비에 보전 사건을 넣으면 마모가 줄어든다"""
        b = base(stations={'HL-AS-01': {'state': 'DOWN'}, HEALTH_ST: {'state': 'RUN', 'wear': 0.95}})
        runs = run(inp([plan(), plan(events=[{'kind': 'pm', 'station': HEALTH_ST, 'atMin': 5}])], hours=1.0, b=b))
        st0 = runs[0]['stations']['HL-AS-01']
        self.assertGreater(st0['sec'].get('DOWN', 0), 0)
        self.assertEqual(st0['failures'], 0)
        # 보전이 없으면 마모가 그대로 남거나, 마모 고장이 나서 수리로 되돌려진다 (어느 쪽인지는 씨앗에 달렸다)
        h0 = runs[0]['stations'][HEALTH_ST]
        self.assertTrue(h0['wearEnd'] > 0.9 or h0['failures'] >= 1, h0)
        self.assertLess(runs[1]['stations'][HEALTH_ST]['wearEnd'], 0.2)
        # 여러 씨앗으로 보면 마모 0.95에서 보전 없이 끝까지 버티는 경우가 보전한 경우보다 마모가 크다
        many = run(inp([plan(), plan(events=[{'kind': 'pm', 'station': HEALTH_ST, 'atMin': 5}])], hours=1.0, reps=3, b=b))
        keep = [r['stations'][HEALTH_ST] for r in many if r['scenario'] == 0]
        pm = [r['stations'][HEALTH_ST] for r in many if r['scenario'] == 1]
        self.assertTrue(all(s['wearEnd'] > 0.9 for s in keep if s['failures'] == 0))
        self.assertTrue(all(s['wearEnd'] < 0.2 for s in pm))

    def test_scenario_elapsed(self):
        """기준 상태의 공정 이상은 elapsedMin만큼 진행된 것으로 이어 간다"""
        sim = Sim(FACTORY, io=None, realtime=False, seed=3, tick=5.0)
        tr = W.Tracker(sim)
        sim.track = tr
        W.apply_base(sim, tr, base(scenarios=[{'id': SCENARIO, 'elapsedMin': 600}]), plan())
        self.assertIn(SCENARIO, sim.scen.active)
        self.assertAlmostEqual(sim.scen.active[SCENARIO], -36000.0)
        self.assertGreater(sim.scen.progress(SCENARIO), 0.0)

    def test_inproc_payload(self):
        """상태 메시지 inproc: 슬롯·배치 설비는 늘 싣고, 슬롯마다 [묶음 개수, 남은 가공 초]. 용량을 넘지 않는다"""
        sim = Sim(FACTORY, io=None, realtime=False, seed=5, tick=5.0)
        sim.env.run(until=3600)
        ip = sim.status_payload()['inproc']
        multi = [st for st in sim.stations.values() if not st.utility and (st.slots > 1 or st.batch > 1)]
        for st in multi:
            self.assertIn(st.code, ip)
        self.assertGreater(len(ip), len(multi), '한 개씩 가공하는 설비도 안에 개체가 있으면 실린다')
        for code, slots in ip.items():
            st = sim.stations[code]
            self.assertLessEqual(len(slots), st.slots, code)
            for n, left in slots:
                self.assertTrue(1 <= n <= st.batch, (code, n))
                self.assertGreaterEqual(left, 0)
        self.assertGreater(sum(n for n, _ in ip['HL-HC-01']), 30, '하드코팅 터널은 1시간 뒤 거의 차 있다')

    def test_inproc_base_preloads(self):
        """기준 상태 inproc: 증착기 안 24개는 남은 시간 뒤 나오고, 빈 터널은 빈 채 시작한다 (없으면 터널은 가득 찬 채)"""
        def first(b: dict, until: float) -> Sim:
            sim = Sim(FACTORY, io=None, realtime=False, seed=3, tick=5.0, streams=True)
            tr = W.Tracker(sim)
            sim.track = tr
            W.apply_base(sim, tr, b, plan())
            sim.env.run(until=until)
            return sim

        self.assertEqual(first(base(), 1200).stats.ok['HL-VM-01'], 0, '없으면 빈 채 시작해 20분 안에 못 낸다')
        self.assertEqual(first(base(inproc={'HL-VM-01': [[24, 600.0]]}), 1200).stats.ok['HL-VM-01'], 24)
        self.assertGreater(first(base(), 1200).stats.ok['HL-HC-01'], 0, '터널형 기본: 가득 찬 채 시작')
        self.assertEqual(first(base(inproc={'HL-HC-01': []}), 1200).stats.ok['HL-HC-01'], 0, '빈 터널: 새로 넣은 것은 45분 뒤에야 나온다')

    def test_inproc_round_trip(self):
        """라이브 상태 메시지 → 기준 상태 → What-if: 설비마다 넣은 개체 수가 같다"""
        live = Sim(FACTORY, io=None, realtime=False, seed=6, tick=5.0)
        live.env.run(until=2 * 3600)
        ip = live.status_payload()['inproc']
        sim = Sim(FACTORY, io=None, realtime=False, seed=1, tick=5.0, streams=True)
        tr = W.Tracker(sim)
        sim.track = tr
        W.apply_base(sim, tr, base(inproc=ip), plan())
        for code, slots in ip.items():
            pre = sim.stations[code].preload
            self.assertIsNotNone(pre, code)
            self.assertEqual(sum(len(loads) for loads, _ in pre.values()), sum(n for n, _ in slots), code)

    def test_buffers_follow_base(self):
        """기준 상태의 버퍼 개수로 재공을 다시 채운다 (용량을 넘지 않게)"""
        sim = Sim(FACTORY, io=None, realtime=False, seed=3, tick=5.0)
        tr = W.Tracker(sim)
        sim.track = tr
        key = ('HL', 'LENS_MOLD')
        cap = sim.buffers[key].capacity
        W.apply_base(sim, tr, base(buffers={'HL.LENS_MOLD': 4, 'HL.REFL_MOLD': cap + 50}), plan())
        self.assertEqual(len(sim.buffers[key].items), 4)
        self.assertEqual(len(sim.buffers[('HL', 'REFL_MOLD')].items), sim.buffers[('HL', 'REFL_MOLD')].capacity)


if __name__ == '__main__':
    unittest.main()
