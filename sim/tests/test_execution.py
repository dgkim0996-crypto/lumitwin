"""실행 MES (P9) 시뮬레이터 쪽 흐름 테스트 (표준 unittest, 브로커 없이 돈다).

가짜 io가 시뮬레이터가 보낸 메시지를 모으고, 가짜 MES(FakeMES)가 요청에 곧바로(가상 0.5초 뒤) 답한다.
공장 데이터(설비 수·코드)는 공장 데이터 담당이 바꿀 수 있어, 라인의 투입 공정·게이트·기종 변경 표처럼
정의에서 찾아 쓰고 숫자를 딱 맞추지 않는다.

실행: npm run test:sim (루트에서)
"""
from __future__ import annotations

import copy
import queue
import time
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone

from lumisim.__main__ import handle
from lumisim.engine import ILK_WAIT_REASON, VIB_WEAR_GAIN, WEAR_AFTER_PM, WEAR_REASON, Sim
from lumisim.model import load_factory, mes_table
from lumisim.mqtt_io import MqttIO, REPLY_ACTION

FACTORY = load_factory()
MES = mes_table(FACTORY)
KST = timezone(timedelta(hours=9))


# ─────────────────────────── 도우미 ───────────────────────────

def line_def(factory: dict, code: str) -> dict:
    return next(ln for ln in factory['lines'] if ln['code'] == code)


def stations_of(factory: dict, line: str, step: str) -> list[dict]:
    return [s for s in line_def(factory, line)['stations'] if s['step'] == step]


def release_station(factory: dict, line: str) -> str:
    ln = line_def(factory, line)
    return stations_of(factory, line, ln['release'])[0]['code']


def product_gates(factory: dict, line: str) -> list[str]:
    """제품 경로의 게이트 설비 (투입 공정 다음부터, 경로 순서대로)"""
    ln = line_def(factory, line)
    steps = mes_table(factory)['productSteps'][line]
    out = []
    for step in steps[1:]:
        for s in stations_of(factory, line, step):
            if s.get('gate'):
                out.append(s['code'])
    return out


def inspection_gate(factory: dict, line: str) -> str:
    """제품 경로에서 측정값이 있는 첫 게이트 설비 (불량 처리 시험용)"""
    m = mes_table(factory)['stations']
    return next(c for c in product_gates(factory, line) if m[c]['inspection'])


def next_station_after(factory: dict, line: str, code: str) -> str:
    ln = line_def(factory, line)
    step = next(s['step'] for s in ln['stations'] if s['code'] == code)
    nxt = next(s for s in ln['steps'] if s['serial'] == 'keep' and s['inputs'][0].get('step') == step)
    return stations_of(factory, line, nxt['code'])[0]['code']


class FakeIO:
    """시뮬레이터 io 자리: 보낸 것을 모은다"""

    link = 'mqtt'

    def __init__(self):
        self.out: list[tuple[str, dict]] = []
        self.cmds: queue.Queue = queue.Queue()

    def publish(self, topic, obj, qos=0):
        self.out.append((topic, obj))

    def of(self, kind: str, station: str | None = None) -> list[dict]:
        """토픽 끝이 kind인 메시지 (예: unit · state · change · insp · health · ilk/req · wo/req · repair · sim/event)"""
        out = []
        for topic, m in self.out:
            if not topic.endswith('/' + kind):
                continue
            if station is not None and topic.split('/')[3] != station:
                continue
            out.append(m)
        return out


class FakeMES:
    """요청에 바로 답하는 MES 흉내.

    wo: 작업지시를 내려 주는가 (False면 wo:null). 기종은 번갈아, 수량 qty
    ilk(msg) → (verdict, code) 또는 None(답하지 않음). 기본은 모두 OK
    ncr(msg) → 판정(REPAIR·SCRAP·UAI) 또는 None. 제품 경로 NG 개체 메시지마다 묻는다 (재검사 NG는 기본 폐기)
    """

    def __init__(self, sim: Sim, qty: int = 5, wo: bool = True, ilk=None, ncr=None):
        self.sim, self.io = sim, sim.io
        self.qty, self.wo = qty, wo
        self.ilk = ilk or (lambda m: ('OK', None))
        self.ncr = ncr
        self.seen = 0
        self.next_id = 100
        self.n = Counter()
        self.dispatched: list[dict] = []
        sim.env.process(self.loop())

    def loop(self):
        while True:
            yield self.sim.env.timeout(0.5)
            out = self.io.out
            while self.seen < len(out):
                topic, m = out[self.seen]
                self.seen += 1
                self.on(topic, m)

    def on(self, topic: str, m: dict) -> None:
        p = topic.split('/')
        if p[-2:] == ['wo', 'req']:
            line = p[2]
            wo = None
            if self.wo:
                self.next_id += 1
                vs = [v['code'] for v in line_def(self.sim.factory, line)['variants']]
                wo = {'id': self.next_id, 'code': f'WO-T-{self.next_id}', 'variant': vs[self.n[line] % len(vs)], 'qty': self.qty}
                self.n[line] += 1
                self.dispatched.append(dict(wo, line=line))
            self.sim.on_reply(f'lt/v1/{line}/wo/res', {'t': m['t'], 'reqId': m['reqId'], 'wo': wo})
        elif p[-2:] == ['ilk', 'req']:
            res = self.ilk(m)
            if res is None:
                return
            verdict, code = res
            self.sim.on_reply(f'lt/v1/{p[2]}/{p[3]}/ilk/res', {'t': m['t'], 'reqId': m['reqId'], 'serial': m['serial'], 'verdict': verdict, 'code': code})
        elif p[-1] == 'unit' and m['result'] == 'NG' and self.ncr is not None:
            if not self.sim.mes['stations'].get(m['station'], {}).get('productScope'):
                return
            d = 'SCRAP' if m.get('reinspect') else self.ncr(m)
            if d:
                self.sim.dispose(m['serial'], d)


def run_live(factory=None, seed: int = 3, until: float = 3600, start: datetime | None = None, **mes_kw) -> tuple[Sim, FakeIO, FakeMES]:
    io = FakeIO()
    sim = Sim(factory or FACTORY, io=io, realtime=False, seed=seed, tick=5.0, start=start)
    mes = FakeMES(sim, **mes_kw)
    if until:
        sim.env.run(until=until)
    return sim, io, mes


def with_test_defect(factory: dict, station: str, base: float = 0.3) -> dict:
    """그 설비에 확률 base로 나는 시험용 불량(TESTNG)을 붙인다"""
    f = copy.deepcopy(factory)
    for ln in f['lines']:
        for s in ln['stations']:
            if s['code'] == station:
                s.setdefault('defects', []).append({'code': 'TESTNG', 'name': '시험 불량', 'base': base, 'drivers': [], 'grade': 'assumed'})
    return f


# ─────────────────────────── 작업지시·기종 ───────────────────────────

class WorkOrders(unittest.TestCase):
    def test_release_carries_wo_variant_and_last(self):
        sim, io, mes = run_live(qty=4, until=2 * 3600)
        rel = release_station(FACTORY, 'HL')
        units = io.of('unit', rel)
        first = [w for w in mes.dispatched if w['line'] == 'HL'][0]
        mine = [u for u in units if u.get('wo') == first['id']]
        self.assertEqual(len(mine), 4, '작업지시 수량만큼 투입한다')
        self.assertTrue(all(u['variant'] == first['variant'] for u in mine))
        self.assertEqual([bool(u.get('woLast')) for u in mine], [False, False, False, True], '마지막 투입 개체에 woLast')
        fin = [m['finished'] for m in io.of('wo/req') if m['line'] == 'HL' and 'finished' in m]
        self.assertIn({'id': first['id'], 'released': 4}, fin, '다 넣으면 끝낸 작업지시와 함께 다음을 요청한다')
        # 제품 경로 다음 공정도 기종·작업지시를 싣고, 제품 경로 밖(앞 공정)은 싣지 않는다
        nxt = next_station_after(FACTORY, 'HL', rel)
        self.assertTrue(any(u.get('wo') == first['id'] and u.get('variant') for u in io.of('unit', nxt)))
        outside = [s['code'] for s in line_def(FACTORY, 'HL')['stations'] if not MES['stations'][s['code']]['productScope']]
        self.assertTrue(all('variant' not in u and 'wo' not in u for c in outside for u in io.of('unit', c)))

    def test_no_plan_stops_release_until_wo_arrives(self):
        sim, io, mes = run_live(wo=False, until=900)
        for line in ('HL', 'EM', 'OSM'):
            st = sim.stations[release_station(FACTORY, line)]
            self.assertEqual((st.state, st.reason), ('STOP', MES['noPlanReason']), line)
            self.assertEqual(io.of('unit', st.code), [])
            lx = sim.status_payload()['lines'][line]
            self.assertTrue(lx['waitingWo'])
            self.assertIsNone(lx['wo'])
        reqs = [m for m in io.of('wo/req') if m['line'] == 'HL']
        self.assertGreaterEqual(len(reqs), 3, '응답이 null이면 실제 5초마다 다시 묻는다')
        self.assertEqual(len({m['reqId'] for m in reqs}), len(reqs))
        # 앞 공정(공용 부품)은 계속 흐른다
        self.assertGreater(sum(len(io.of('unit', s['code'])) for s in line_def(FACTORY, 'HL')['stations'] if not MES['stations'][s['code']]['productScope']), 0)
        self.assertTrue(any(m['kind'] == 'wo' for m in io.of('sim/event')))
        # 계획이 생기면 투입을 시작한다
        mes.wo = True
        sim.env.run(until=sim.env.now + 600)
        st = sim.stations[release_station(FACTORY, 'HL')]
        self.assertGreater(len(io.of('unit', st.code)), 0)
        self.assertFalse(sim.status_payload()['lines']['HL']['waitingWo'] and sim.lines['HL'].wo is None)

    def test_changeover_wave_with_setup_change_and_first_article(self):
        sim, io, mes = run_live(qty=3, until=3 * 3600)
        ln = line_def(FACTORY, 'HL')
        wos = [w for w in mes.dispatched if w['line'] == 'HL']
        self.assertGreaterEqual(len(wos), 2)
        second = wos[1]
        start2 = next(m['t'] for m in io.of('sim/event') if m['kind'] == 'wo' and second['code'] in m['message'] and '시작' in m['message'])
        a, b = wos[0]['variant'].rsplit('-', 1)[-1], second['variant'].rsplit('-', 1)[-1]
        for co in ln['changeover']:
            code = co['station']
            setups = [m for m in io.of('state', code) if m['state'] == 'SETUP']
            self.assertTrue(setups, f'{code} 셋업 없음')
            self.assertEqual(setups[0]['reason'], f'기종 변경 {a}→{b}')
            self.assertGreaterEqual(setups[0]['t'], start2, '실행 처음의 첫 기종은 셋업 없이 시작한다')
            changes = [m for m in io.of('change', code) if m['kind'] == 'changeover']
            self.assertTrue(changes, f'{code} 기종 변경 변경점 없음')
            c = changes[0]
            self.assertEqual((c['category'], c['fa']), ('METHOD', MES['stations'][code]['faRequired']))
            if c['fa']:
                # 셋업 뒤 첫 개체가 그 변경점의 초물이다
                firsts = [m for m in io.of('insp', code) if m['type'] == 'FIRST' and m['change'] == c['id']]
                self.assertTrue(firsts, f'{code} 초물 검사 없음')
                u = next(u for u in io.of('unit', code) if u['serial'] == firsts[0]['serial'])
                self.assertTrue(u.get('fa'))
                self.assertEqual(u['variant'], second['variant'])
        events = [m for m in io.of('sim/event') if m['kind'] == 'changeover']
        self.assertTrue({co['station'] for co in ln['changeover']} <= {m.get('station') for m in events})

    def test_variant_cycle_multiplier(self):
        """기종 사이클 배수: 배수가 있는 기종은 그 설비에서 더 오래 걸린다"""
        sim, io, mes = run_live(qty=6, until=4 * 3600)
        for ln in FACTORY['lines']:
            for v in ln['variants']:
                for code, k in (v.get('cycle') or {}).items():
                    if abs(k - 1) < 0.05:
                        continue
                    us = io.of('unit', code)
                    slow = [u['cycle'] for u in us if u.get('variant') == v['code']]
                    other = [u['cycle'] for u in us if u.get('variant') and u['variant'] != v['code']]
                    if len(slow) < 3 or len(other) < 3:
                        continue
                    ratio = (sum(slow) / len(slow)) / (sum(other) / len(other))
                    self.assertAlmostEqual(ratio, k, delta=0.08, msg=f'{code} {v["code"]}')

    def test_wo_cancel_requests_next(self):
        sim, io, mes = run_live(qty=200, until=900)
        lx = sim.lines['HL']
        cur = lx.wo['id']
        released = lx.released
        handle(sim, {'action': 'wo-cancel', 'line': 'HL', 'id': cur}, FACTORY, io)
        self.assertNotEqual((lx.wo or {}).get('id'), cur)
        sim.env.run(until=sim.env.now + 1)
        fin = [m['finished'] for m in io.of('wo/req') if m['line'] == 'HL' and 'finished' in m]
        self.assertEqual(fin[-1], {'id': cur, 'released': released})
        sim.env.run(until=sim.env.now + 1200)
        later = [u for u in io.of('unit', release_station(FACTORY, 'HL')) if u['t'] > sim.iso_at(900 + 60)]
        self.assertTrue(later and all(u['wo'] != cur for u in later), '중단한 작업지시는 더 투입하지 않는다')

    def test_offline_local_work_orders_alternate(self):
        f = copy.deepcopy(FACTORY)
        f.setdefault('mes', {})['woLot'] = {'HL': 4, 'EM': 4, 'OSM': 4}
        sim = Sim(f, io=None, realtime=False, seed=2, tick=5.0)
        sim.env.run(until=2 * 3600)
        for line in ('HL', 'EM', 'OSM'):
            lx = sim.lines[line]
            self.assertGreaterEqual(lx.local_n, 3, line)
            if len(lx.variants) > 1:
                st = sim.stations[release_station(f, line)]
                self.assertIn(st.cur_variant, lx.variants)


# ─────────────────────────── 인터록 ───────────────────────────

class Interlock(unittest.TestCase):
    def test_ng_goes_to_quarantine_then_release(self):
        gate = product_gates(FACTORY, 'HL')[1]
        held = {'serial': None, 'released': False}

        def ilk(m):
            if m['station'] == gate and held['serial'] is None:
                held['serial'] = m['serial']
            if m['serial'] == held['serial'] and not held['released']:
                return 'NG', 'HOLD'
            return 'OK', None

        sim, io, mes = run_live(qty=50, ilk=ilk, until=3600)
        s = held['serial']
        self.assertIsNotNone(s)
        self.assertFalse([u for u in io.of('unit', gate) if u['serial'] == s], '격리된 개체는 실적을 내지 않는다')
        self.assertEqual(sim.status_payload()['lines']['HL']['quarantine'], 1)
        self.assertGreater(len(io.of('unit', gate)), 3, '다음 개체는 계속 흐른다')
        held['released'] = True
        handle(sim, {'action': 'release', 'serials': [s]}, FACTORY, io)
        sim.env.run(until=sim.env.now + 1200)
        self.assertEqual(sim.status_payload()['lines']['HL']['quarantine'], 0)
        again = [m for m in io.of('ilk/req', gate) if m['serial'] == s]
        self.assertGreaterEqual(len(again), 2, '풀린 개체는 다시 인터록을 묻는다')
        self.assertEqual(len([u for u in io.of('unit', gate) if u['serial'] == s]), 1, '풀린 개체가 다시 가공된다')

    def test_quarantine_at_new_serial_release_keeps_serial_and_parts(self):
        """새 발번 투입 공정에서 걸린 묶음은 풀려도 같은 시리얼로, 부품을 다시 소비하지 않고 가공한다"""
        rel = release_station(FACTORY, 'HL')
        held = {'serial': None, 'released': False}

        def ilk(m):
            if m['station'] == rel and held['serial'] is None and m.get('comps'):
                held['serial'] = m['serial']
            if m['serial'] == held['serial'] and not held['released']:
                return 'NG', 'HOLD'
            return 'OK', None

        sim, io, mes = run_live(qty=50, ilk=ilk, until=5400)
        s = held['serial']
        self.assertIsNotNone(s)
        first = next(m for m in io.of('ilk/req', rel) if m['serial'] == s)
        held['released'] = True
        sim.release_hold([s])
        sim.env.run(until=sim.env.now + 900)
        again = [m for m in io.of('ilk/req', rel) if m['serial'] == s]
        self.assertEqual(again[-1]['comps'], first['comps'])
        self.assertEqual(again[-1]['lots'], first['lots'])
        [u] = [u for u in io.of('unit', rel) if u['serial'] == s]
        self.assertEqual(u['lots'], first['lots'], '자재를 다시 쓰지 않는다 (같은 LOT)')

    def test_scrap_from_quarantine(self):
        gate = product_gates(FACTORY, 'OSM')[0]
        held = {'serial': None}

        def ilk(m):
            if m['station'] == gate and held['serial'] is None:
                held['serial'] = m['serial']
            return ('NG', 'NG') if m['serial'] == held['serial'] else ('OK', None)

        sim, io, mes = run_live(qty=50, ilk=ilk, until=2400)
        self.assertEqual(sim.status_payload()['lines']['OSM']['quarantine'], 1)
        handle(sim, {'action': 'scrap', 'serials': [held['serial']]}, FACTORY, io)
        self.assertEqual(sim.status_payload()['lines']['OSM']['quarantine'], 0)
        self.assertEqual(sim.lines['OSM'].scrapped, 1)

    def test_ng_mid_cycle_stops_immediately(self):
        """사이클이 끝나기 전에 NG가 오면 즉시 멈춘다: 다음 투입이 한 사이클보다 빨리 시작된다"""
        gate = product_gates(FACTORY, 'HL')[0]
        held = {'serial': None}

        def ilk(m):
            if m['station'] == gate and held['serial'] is None:
                held['serial'] = m['serial']
            return ('NG', 'ROUTE') if m['serial'] == held['serial'] else ('OK', None)

        sim, io, mes = run_live(qty=50, ilk=ilk, until=3600)
        reqs = io.of('ilk/req', gate)
        i = next(k for k, m in enumerate(reqs) if m['serial'] == held['serial'])
        self.assertLess(i + 1, len(reqs))
        gap = (datetime.fromisoformat(reqs[i + 1]['t'].replace('Z', '+00:00')) - datetime.fromisoformat(reqs[i]['t'].replace('Z', '+00:00'))).total_seconds()
        cycle = next(s['cycle'] for s in line_def(FACTORY, 'HL')['stations'] if s['code'] == gate)
        self.assertLess(gap, cycle * 0.5 + 60, f'NG 뒤 다음 투입까지 {gap:.0f}초 (사이클 {cycle}초)')

    def test_timeout_passes_with_ilk_skip_and_bypass(self):
        sim, io, mes = run_live(qty=50, ilk=lambda m: None, until=3600)
        gates = product_gates(FACTORY, 'HL')
        units = [u for g in gates for u in io.of('unit', g)]
        self.assertTrue(units)
        self.assertTrue(all(u.get('ilkSkip') for u in units), 'MES가 답하지 않으면 확인 없이 통과시키고 표시한다')
        self.assertTrue(sim.ilk_bypass, '연달아 시간 초과면 응답이 올 때까지 사이클 뒤에 더 기다리지 않는다')
        # 응답이 다시 오면 확인 대기로 돌아간다
        mes.ilk = lambda m: ('OK', None)
        switch = sim.env.now
        sim.env.run(until=sim.env.now + 1800)
        self.assertFalse(sim.ilk_bypass)
        # 바꾼 뒤 투입한 개체 (사이클 하나 이상 지나 끝난 것)는 확인을 받고 통과한다
        late = [u for g in gates for u in io.of('unit', g) if u['start'] > sim.iso_at(switch + 1)]
        self.assertTrue(late)
        self.assertFalse(any(u.get('ilkSkip') for u in late))

    def test_wait_shows_idle_reason_and_retries(self):
        gate = product_gates(FACTORY, 'HL')[0]
        asked = Counter()

        def ilk(m):
            if m['station'] == gate:
                asked[m['serial']] += 1
                if len(asked) == 1 and asked[m['serial']] <= 3:
                    return 'WAIT', 'ROUTE'
            return 'OK', None

        sim, io, mes = run_live(qty=50, ilk=ilk, until=3600)
        s = next(iter(asked))
        self.assertGreaterEqual(asked[s], 4, 'WAIT이면 ILK_RETRY_SEC마다 다시 묻는다')
        self.assertTrue(any(m['state'] == 'IDLE' and m.get('reason') == ILK_WAIT_REASON for m in io.of('state', gate)))
        self.assertEqual(len([u for u in io.of('unit', gate) if u['serial'] == s]), 1)

    def test_wait_for_first_article_makes_this_unit_first(self):
        """MES가 초물 대기(FA)로 WAIT을 주면 이 개체를 초물로 삼아 다시 묻는다"""
        gate = product_gates(FACTORY, 'HL')[1]
        state = {'pending': True}

        def ilk(m):
            if m['station'] == gate and state['pending']:
                if m.get('fa'):
                    state['pending'] = False
                    return 'OK', None
                return 'WAIT', 'FA'
            return 'OK', None

        sim, io, mes = run_live(qty=50, ilk=ilk, until=3600)
        self.assertFalse(state['pending'])
        fa_units = [u for u in io.of('unit', gate) if u.get('fa')]
        self.assertTrue(fa_units)
        firsts = [m for m in io.of('insp', gate) if m['type'] == 'FIRST']
        self.assertEqual(firsts[0]['serial'], fa_units[0]['serial'])

    def test_unknown_initial_wip_is_not_checked(self):
        """처음 재공(MES가 모르는 시리얼)은 인터록 요청의 부품 목록에서 빠지고, 주 개체면 묻지 않는다.
        곧 요청에 실린 부품·이어 쓰는 주 개체는 모두 그 전에 실적이 난 시리얼이다"""
        sim, io, mes = run_live(qty=50, until=1800)
        keep = {s['code'] for ln in FACTORY['lines'] for st in ln['stations'] for s in ln['steps'] if s['code'] == st['step'] and s['serial'] == 'keep'}
        keep_st = {st['code'] for ln in FACTORY['lines'] for st in ln['stations'] if st['step'] in keep}
        known: set[str] = set()
        asked = 0
        for topic, m in io.out:
            if topic.endswith('/unit'):
                known.add(m['serial'])
            elif topic.endswith('/ilk/req'):
                asked += 1
                self.assertTrue(set(m['comps']) <= known, m)
                if m['station'] in keep_st:
                    self.assertIn(m['serial'], known)
        self.assertGreater(asked, 10)

    def test_offline_has_no_interlock(self):
        sim = Sim(FACTORY, io=None, realtime=False, seed=1, tick=5.0)
        self.assertFalse(any(st.ilk_on for st in sim.stations.values()))


# ─────────────────────────── 불량 처리 ───────────────────────────

class NonConformance(unittest.TestCase):
    def test_repair_then_reinspect(self):
        gate = inspection_gate(FACTORY, 'HL')
        f = with_test_defect(FACTORY, gate, base=0.3)
        f.setdefault('mes', copy.deepcopy(MES))['ngRule'] = copy.deepcopy(MES['ngRule'])
        f['mes']['ngRule'].setdefault(gate, {})['TESTNG'] = {'action': 'REPAIR', 'rule': 'defect-rule', 'minutes': 5, 'prob': 1.0}
        sim, io, mes = run_live(f, qty=50, ncr=lambda m: 'REPAIR', until=3 * 3600)
        reps = [m for m in io.of('repair') if m['line'] == 'HL']
        self.assertTrue(reps, '수리 결과가 없다')
        r = reps[0]
        self.assertEqual((r['action'], r['ok'], r['backTo']), ('REPAIR', True, gate))
        self.assertGreater(r['minutes'], 0)
        re_units = [u for u in io.of('unit', gate) if u['serial'] == r['serial'] and u.get('reinspect')]
        self.assertEqual(len(re_units), 1, '수리 뒤 검출 설비에서 재검사한다')
        self.assertNotIn('comps', re_units[0])
        self.assertNotIn('lots', re_units[0])
        re_req = [m for m in io.of('ilk/req', gate) if m['serial'] == r['serial'] and m.get('reinspect')]
        self.assertTrue(re_req, '재검사 투입은 reinspect로 인터록을 묻는다')
        # MES가 판정을 바로 내리므로 불량 대기에 오래 남는 개체가 없다
        self.assertLessEqual(sim.status_payload()['lines']['HL']['ngPen'], 1)
        # 알 수 없는 판정은 무시하고 불량 대기에 그대로 둔다
        ng = next((u for u in io.of('unit', gate) if u['result'] == 'NG' and u['serial'] in sim.pen), None)
        if ng:
            self.assertFalse(sim.dispose(ng['serial'], 'FOO'))
            self.assertIn(ng['serial'], sim.pen)

    def test_offline_applies_default_rule(self):
        gate = inspection_gate(FACTORY, 'HL')
        f = with_test_defect(FACTORY, gate, base=0.3)
        sim = Sim(f, io=None, realtime=False, seed=5, tick=5.0)
        sim.env.run(until=3 * 3600)
        lx = sim.lines['HL']
        self.assertGreater(lx.repaired, 0, '검사 공정 불량은 수리 뒤 재검사 (기본 규칙)')
        self.assertGreater(lx.scrapped, 0, '재검사 불합격·수리 실패는 폐기')
        self.assertEqual(lx.pen_n, 0, '오프라인은 판정을 기다리지 않는다')

    def test_uai_passes_to_next_process_without_new_record(self):
        gate = inspection_gate(FACTORY, 'HL')
        f = with_test_defect(FACTORY, gate, base=0.2)
        sim, io, mes = run_live(f, qty=50, ncr=lambda m: 'UAI', until=2 * 3600)
        ng = [u['serial'] for u in io.of('unit', gate) if u['result'] == 'NG']
        self.assertTrue(ng)
        nxt = next_station_after(f, 'HL', gate)
        passed = {u['serial'] for u in io.of('unit', nxt)}
        self.assertTrue(set(ng) & passed, '특채품은 다음 공정으로 넘어간다')
        self.assertTrue(all(len([u for u in io.of('unit', gate) if u['serial'] == s]) == 1 for s in ng), '실적을 다시 내지 않는다')

    def test_pen_waits_for_disposition_online(self):
        gate = inspection_gate(FACTORY, 'HL')
        f = with_test_defect(FACTORY, gate, base=0.3)
        sim, io, mes = run_live(f, qty=50, until=3600)  # MES가 판정을 내리지 않는다
        pen = sim.status_payload()['lines']['HL']['ngPen']
        ng = [u for u in io.of('unit', gate) if u['result'] == 'NG']
        self.assertEqual(pen, len(ng), '판정 전까지 불량 대기에 둔다')
        handle(sim, {'action': 'disposition', 'serial': ng[0]['serial'], 'decision': 'SCRAP'}, f, io)
        self.assertEqual(sim.status_payload()['lines']['HL']['ngPen'], pen - 1)


# ─────────────────────────── 변경점·초중종물 ───────────────────────────

class ChangePoints(unittest.TestCase):
    def test_shift_change_last_then_man_change_then_first(self):
        start = datetime(2026, 11, 13, 7, 40, tzinfo=KST)
        sim, io, mes = run_live(qty=50, start=start, until=3600)
        shift_t = '2026-11-12T23:00:00.000Z'  # 한국 08:00
        fa_st = [c for c, v in MES['stations'].items() if v['faRequired']]
        changes = [m for m in io.of('change') if m['kind'] == 'shift']
        self.assertEqual({m['station'] for m in changes}, set(fa_st))
        self.assertTrue(all(m['category'] == 'MAN' and m['fa'] and m['t'] == shift_t and '주간' in m['detail'] for m in changes))
        rel = release_station(FACTORY, 'HL')
        c = next(m for m in changes if m['station'] == rel)
        # 종물: 교대가 끝나는 순간 그 설비가 마지막으로 가공한 개체
        topics = [(t.split('/')[-1], m) for t, m in io.out if t.split('/')[3:4] == [rel] and t.endswith(('/insp', '/change'))]
        k = next(i for i, (kind, m) in enumerate(topics) if kind == 'change' and m['id'] == c['id'])
        before = [m for kind, m in topics[:k] if kind == 'insp']
        self.assertTrue(before and before[-1]['type'] == 'LAST' and before[-1]['t'] == shift_t)
        # 초물: 변경점 뒤 첫 개체 (그 사이 다른 변경점이 생기면 마지막 id로 묶인다)
        firsts = [m for m in io.of('insp', rel) if m['type'] == 'FIRST' and m['t'] > shift_t]
        self.assertTrue(firsts)
        u = next(u for u in io.of('unit', rel) if u['serial'] == firsts[0]['serial'])
        self.assertTrue(u.get('fa'))
        ids = [m['id'] for m in io.of('change', rel)]
        self.assertGreaterEqual(ids.index(firsts[0]['change']), ids.index(c['id']))

    def test_user_change_sets_first_article_without_change_msg(self):
        sim, io, mes = run_live(qty=50, until=1800)
        code = product_gates(FACTORY, 'HL')[0]
        handle(sim, {'action': 'change', 'id': 'U7', 'code': code, 'category': 'METHOD', 'kind': 'user', 'detail': '조건 변경', 'fa': True}, FACTORY, io)
        sim.env.run(until=sim.env.now + 1800)
        self.assertFalse([m for m in io.of('change') if m['id'] == 'U7'], '사용자 변경점은 다시 보내지 않는다')
        [first] = [m for m in io.of('insp', code) if m.get('change') == 'U7']
        self.assertEqual(first['type'], 'FIRST')
        self.assertTrue(next(u for u in io.of('unit', code) if u['serial'] == first['serial']).get('fa'))

    def test_first_article_ng_makes_next_unit_first_again(self):
        gate = inspection_gate(FACTORY, 'HL')
        f = with_test_defect(FACTORY, gate, base=0.5)
        sim, io, mes = run_live(f, qty=50, ncr=lambda m: 'SCRAP', until=1800)
        handle(sim, {'action': 'change', 'id': 'U9', 'code': gate, 'category': 'METHOD', 'kind': 'user', 'detail': '시험', 'fa': True}, f, io)
        sim.env.run(until=sim.env.now + 3600)
        firsts = [m for m in io.of('insp', gate) if m.get('change') == 'U9']
        self.assertTrue(firsts)
        k = next((i for i, m in enumerate(firsts) if m['result'] == 'OK'), None)
        self.assertIsNotNone(k)
        self.assertTrue(all(m['result'] == 'NG' for m in firsts[:k]), '초물이 NG면 다음 개체가 다시 초물')
        self.assertEqual(len(firsts), k + 1, '합격하면 초물 대기가 풀린다')

    def test_mid_inspection_interval(self):
        f = copy.deepcopy(FACTORY)
        f.setdefault('mes', copy.deepcopy(MES))['midInspectHours'] = 0.25
        sim, io, mes = run_live(f, qty=50, until=3600)
        mids = Counter(m['station'] for m in io.of('insp') if m['type'] == 'MID')
        rel = release_station(f, 'HL')
        self.assertGreaterEqual(mids[rel], 2)
        self.assertTrue(set(mids) <= {c for c, v in MES['stations'].items() if v['faRequired']}, '중물은 초물 대상 설비만')

    def test_repair_and_lot_change_points(self):
        sim, io, mes = run_live(qty=50, until=900)
        code = release_station(FACTORY, 'HL')
        sim.station_op(code, 'fail', '시험')
        sim.env.run(until=sim.env.now + 120)
        sim.station_op(code, 'repair')
        rep = [m for m in io.of('change', code) if m['kind'] == 'repair']
        self.assertEqual(len(rep), 1)
        self.assertEqual((rep[0]['category'], rep[0]['fa']), ('MACHINE', MES['stations'][code]['faRequired']))
        # LOT Hold: 쓰는 중인 LOT를 바로 바꾸고, 쓰는 설비에 LOT 변경점이 생긴다
        step = next(s for s in line_def(FACTORY, 'HL')['steps'] if s['code'] == line_def(FACTORY, 'HL')['release'])
        mat = next(i['material'] for i in step['inputs'] if 'material' in i)
        old = sim.lots.cur[mat]
        handle(sim, {'action': 'lot-hold', 'material': mat, 'lot': old}, FACTORY, io)
        self.assertNotEqual(sim.lots.cur[mat], old)
        sim.env.run(until=sim.env.now + 900)
        lot = [m for m in io.of('change', code) if m['kind'] == 'lot' and old in m['detail']]
        self.assertTrue(lot, 'LOT 변경점이 없다')
        self.assertEqual(lot[0]['category'], 'MATERIAL')
        self.assertIn(f'{mat} LOT {old} → {sim.lots.cur[mat]}', lot[0]['detail'])


# ─────────────────────────── 예지 보전 ───────────────────────────

def with_health(factory: dict, code: str, wear_hours: float = 2.0) -> dict:
    f = copy.deepcopy(factory)
    for ln in f['lines']:
        for s in ln['stations']:
            if s['code'] == code and not s.get('health'):
                s['health'] = {'vib': 1.5, 'cur': 10.0, 'temp': 45.0, 'wearHours': wear_hours, 'part': '시험 베어링', 'cls': 'II', 'grade': 'assumed'}
            elif s['code'] == code:
                s['health'] = dict(s['health'], wearHours=wear_hours)
    return f


class Health(unittest.TestCase):
    CODE = 'HL-IM-L1'

    def code(self) -> str:
        sts = {s['code'] for ln in FACTORY['lines'] for s in ln['stations']}
        return self.CODE if self.CODE in sts else next(s['code'] for ln in FACTORY['lines'] for s in ln['stations'] if s['cycle'] > 0)

    def test_health_messages_follow_wear(self):
        code = self.code()
        f = with_health(FACTORY, code, wear_hours=1.5)
        sim, io, mes = run_live(f, qty=50, until=2 * 3600)
        msgs = io.of('health', code)
        iv = MES['healthIntervalSec']
        self.assertAlmostEqual(len(msgs), 2 * 3600 / iv, delta=2)
        self.assertEqual(set(msgs[0]['v']), {'vib', 'cur', 'temp'})
        st = sim.stations[code]
        h = st.health
        st.state = 'RUN'
        st.wear = 0.0
        low = [st.health_payload()['v']['vib'] for _ in range(50)]
        st.wear = 1.0
        high = [st.health_payload()['v']['vib'] for _ in range(50)]
        self.assertAlmostEqual(sum(low) / 50, h['vib'], delta=h['vib'] * 0.05)
        self.assertAlmostEqual(sum(high) / 50, h['vib'] * (1 + VIB_WEAR_GAIN), delta=h['vib'] * 0.3)
        self.assertEqual(VIB_WEAR_GAIN, 6.0, '계약 2.6: vib ≈ vib0·(1 + 6·wear²)')
        st.refresh_state()

    def test_wear_raises_failure_with_reason_and_repair_resets(self):
        code = self.code()
        f = with_health(FACTORY, code, wear_hours=1000)
        sim, io, mes = run_live(f, qty=50, until=300)
        st = sim.stations[code]
        st.state = 'RUN'
        st.wear = 1.0
        st.health_tick(1e7)   # 마모 1: 고장률이 커져 이 긴 구간 안에 반드시 고장
        self.assertTrue(st.down)
        self.assertEqual(st.reason, WEAR_REASON)
        sim.station_op(code, 'repair')
        self.assertAlmostEqual(st.wear, 0.1)
        # 마모가 낮으면 마모 고장은 나지 않는다 (이 구간 동안 마모가 쌓이지 않게 속도를 0으로)
        st.state, st.wear, st.wear_rate = 'RUN', 0.3, 0.0
        st.health_tick(1e7)
        self.assertFalse(st.down)
        st.refresh_state()

    def test_pm_stops_then_restarts_and_resets_wear(self):
        code = self.code()
        f = with_health(FACTORY, code, wear_hours=1000)
        sim, io, mes = run_live(f, qty=50, until=600)
        st = sim.stations[code]
        st.wear = 0.7
        handle(sim, {'action': 'station', 'code': code, 'op': 'pm'}, f, io)
        self.assertEqual((st.state, st.reason), ('STOP', MES['pmReason']))
        minutes = MES['pmMinutes'].get(code, 20)
        sim.env.run(until=sim.env.now + minutes * 60 - 5)
        self.assertEqual(st.state, 'STOP')
        sim.env.run(until=sim.env.now + 30)
        self.assertNotEqual(st.state, 'STOP', '보전 시간이 지나면 스스로 재가동한다')
        self.assertAlmostEqual(st.wear, WEAR_AFTER_PM, delta=0.01)
        [c] = [m for m in io.of('change', code) if m['kind'] == 'pm']
        self.assertEqual((c['category'], c['fa']), ('MACHINE', MES['stations'][code]['faRequired']))
        self.assertEqual(len([m for m in io.of('sim/event') if m['kind'] == 'pm' and m.get('station') == code]), 2)

    def test_wear_scenario_speeds_up_wear(self):
        code = self.code()
        f = with_health(FACTORY, code, wear_hours=100)
        f['scenarios'] = f['scenarios'] + [{'id': 'T-WEAR', 'name': '시험 마모', 'line': 'HL', 'summary': '', 'symptom': '', 'rootCause': '', 'howToFind': '',
                                             'effects': [{'station': code, 'target': 'wear', 'mode': 'step', 'amount': 4}]}]
        deltas = []
        for on in (False, True):
            sim = Sim(f, io=None, realtime=False, seed=9, tick=5.0)
            if on:
                sim.scenario('T-WEAR', True)
            w0 = sim.stations[code].wear
            sim.env.run(until=3600)
            deltas.append(sim.stations[code].wear - w0)
        self.assertGreater(deltas[0], 0)
        self.assertAlmostEqual(deltas[1] / deltas[0], 5.0, delta=1.0)


# ─────────────────────────── 연배 분할 ───────────────────────────

class Split(unittest.TestCase):
    def test_split_makes_n_units_from_one(self):
        f = copy.deepcopy(FACTORY)
        target = None
        for ln in f['lines']:
            for s in ln['steps']:
                if s.get('split', 1) > 1:
                    target = (ln['code'], s['code'])
        if target is None:
            # 데이터에 아직 분할 공정이 없으면 LED 라우팅(또는 새 발번이 아닌 아무 공정)에 4연배를 건다
            ln = line_def(f, 'EM')
            step = next((s for s in ln['steps'] if s['code'] == 'LED_ROUTE'), None) or next(s for s in ln['steps'] if s['serial'] == 'keep')
            step['split'] = 4
            for s in ln['stations']:
                if s['step'] == step['code']:
                    s.pop('batch', None)
            target = ('EM', step['code'])
        line, step_code = target
        n = next(s for s in line_def(f, line)['steps'] if s['code'] == step_code)['split']
        code = stations_of(f, line, step_code)[0]['code']
        sim, io, mes = run_live(f, qty=50, until=3600)
        units = io.of('unit', code)
        self.assertGreaterEqual(len(units), n * 3)
        by_parent = {}
        for u in units:
            self.assertEqual(len(u['comps']), 1)
            parent = u['comps'][0]
            self.assertTrue(u['serial'].startswith(parent + '-'))
            by_parent.setdefault(parent, []).append(u['serial'])
        for parent, kids in list(by_parent.items())[:-1]:
            self.assertEqual(kids, [f'{parent}-{k}' for k in range(1, n + 1)])


# ─────────────────────────── 상태·명령·성능 ───────────────────────────

class StatusAndCommands(unittest.TestCase):
    def test_status_lines_shape(self):
        sim, io, mes = run_live(qty=50, until=600)
        lines = sim.status_payload()['lines']
        self.assertEqual(set(lines), {ln['code'] for ln in FACTORY['lines']})
        for st in lines.values():
            self.assertEqual(set(st), {'wo', 'variant', 'waitingWo', 'ngPen', 'repair', 'quarantine'})
            self.assertEqual(set(st['wo']), {'id', 'code', 'variant', 'qty', 'released'})
        statuses = io.of('sim/status')
        self.assertIn('lines', statuses[-1])

    def test_reply_routing_through_command_queue(self):
        """MQTT 응답 토픽은 명령 큐로 넘어가고, handle이 시뮬레이터로 전달한다"""

        class Msg:
            def __init__(self, topic, payload):
                self.topic, self.payload = topic, payload

        class Dummy:
            cmds = queue.Queue()

        MqttIO._on_message(Dummy, None, None, Msg('lt/v1/cmd', b'{"action":"pause"}'))
        MqttIO._on_message(Dummy, None, None, Msg('lt/v1/HL/wo/res', '{"reqId":"x","wo":null}'.encode()))
        self.assertEqual(Dummy.cmds.get_nowait(), {'action': 'pause'})
        self.assertEqual(Dummy.cmds.get_nowait(), {'action': REPLY_ACTION, 'topic': 'lt/v1/HL/wo/res', 'msg': {'reqId': 'x', 'wo': None}})
        io = FakeIO()
        sim = Sim(FACTORY, io=io, realtime=False, seed=1, tick=5.0)
        sim.env.run(until=30)
        req = io.of('wo/req')[0]
        sim = handle(sim, {'action': REPLY_ACTION, 'topic': f'lt/v1/{req["line"]}/wo/res',
                           'msg': {'reqId': req['reqId'], 'wo': {'id': 7, 'code': 'WO-7', 'variant': line_def(FACTORY, req['line'])['variants'][0]['code'], 'qty': 3}}}, FACTORY, io)
        self.assertEqual(sim.lines[req['line']].wo['id'], 7)

    def test_same_seed_same_records_with_mes(self):
        def run():
            sim, io, mes = run_live(seed=21, qty=5, until=1800, start=datetime(2026, 11, 13, 9, 0, tzinfo=KST))
            return [(t, {k: v for k, v in m.items() if k != 'reqId'}) for t, m in io.out if t.endswith(('/unit', '/change', '/insp'))]

        self.assertEqual(run(), run())

    def test_fast_enough_for_60x(self):
        """60배속: 가상 1시간을 실제 60초 안에 계산해야 따라간다 (메시지 발행 포함). 여유를 크게 둔다"""
        t0 = time.perf_counter()
        run_live(qty=20, until=3600)
        self.assertLess(time.perf_counter() - t0, 15.0)


if __name__ == '__main__':
    unittest.main()
