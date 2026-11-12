"""시뮬레이터 핵심 동작 테스트 (표준 unittest, 브로커 없이 돈다).

실행: node scripts/sim.mjs --test   (또는 sim 폴더에서 python -m unittest discover -s tests -v)
먼저 shared/dist/factory.json이 있어야 한다 (`npm install` 또는 `npm run build -w shared`).
"""
from __future__ import annotations

import copy
import time
import unittest

from lumisim.__main__ import MAX_LAG_SEC, resync_if_behind
from lumisim.engine import Scenarios, Sim, resync_clock
from lumisim.model import defect_probability, load_factory

FACTORY = load_factory()


def offline(seed: int = 7, hours: float = 2.0, scenario: str | None = None, at_hours: float = 0.5) -> Sim:
    sim = Sim(FACTORY, io=None, realtime=False, seed=seed, tick=5.0)
    if scenario:
        def starter():
            yield sim.env.timeout(at_hours * 3600)
            sim.scenario(scenario, True)

        sim.env.process(starter())
    sim.env.run(until=hours * 3600)
    sim.flush_stats()
    return sim


def snapshot(sim: Sim) -> tuple:
    st = sim.stats
    return dict(st.ok), dict(st.ng), dict(sim.warehouse), dict(sim.escaped)


class OfflineRun(unittest.TestCase):
    def test_same_seed_same_result(self):
        """씨앗이 같으면 결과가 같다 (보정·회귀 비교의 전제)"""
        self.assertEqual(snapshot(offline(seed=11)), snapshot(offline(seed=11)))

    def test_factory_produces_and_ships(self):
        sim = offline(seed=3, hours=3)
        for ln in FACTORY['lines']:
            final = [s['code'] for s in ln['stations'] if s['step'] == ln['finalStep']]
            out = sum(sim.stats.ok[c] for c in final)
            target = 3 * 3600 / ln['taktSec']
            # 처음 몇 분은 버퍼가 채워지는 구간이라 목표의 절반만 넘으면 정상으로 본다
            self.assertGreater(out, target * 0.5, f'{ln["code"]} 완성 {out}개 (목표 {target:.0f})')
        self.assertGreater(sum(sim.warehouse.values()), 0, '완제품 창고로 입고된 것이 없다')

    def test_state_time_adds_up(self):
        """설비마다 상태별 시간을 더하면 돌린 시간과 같다 (OEE 계산의 바탕)"""
        sim = offline(seed=5, hours=1)
        for code, secs in sim.stats.state_sec.items():
            self.assertAlmostEqual(sum(secs.values()), 3600, delta=1e-6, msg=code)


class ScenarioEffects(unittest.TestCase):
    def test_leak_gauge_drift_raises_leak_ng(self):
        """리크 테스터 영점 드리프트 → 그 설비의 LEAK 불량이 크게 는다"""
        base = offline(seed=7, hours=3)
        hit = offline(seed=7, hours=3, scenario='HL-LEAK-GAUGE')
        b = base.stats.defects['HL-LT-01']['LEAK']
        h = hit.stats.defects['HL-LT-01']['LEAK']
        self.assertGreaterEqual(h, max(10, 3 * b), f'기준 {b}건 → 시나리오 {h}건')

    def test_drift_is_capped_by_limit(self):
        e = {'mode': 'drift', 'rate': -0.15, 'limit': -6}
        self.assertAlmostEqual(Scenarios._level(e, 600), -1.5)   # 10분 × −0.15/분
        self.assertEqual(Scenarios._level(e, 3600 * 5), -6)       # 상한에서 멈춘다
        self.assertEqual(Scenarios._level({'mode': 'step', 'amount': 0.22}, 1), 0.22)

    def test_bad_lot_only_hits_parts_using_it(self):
        """불량 LOT 시나리오는 그 LOT를 쓴 부품에만 효과가 있고, 끄면 LOT를 교체한다"""
        sim = Sim(FACTORY, io=None, realtime=False, seed=1)
        sim.scenario('OSM-GEAR-LOT', True)
        bad = sim.scen.bad_lot[('OSM-GEAR-LOT', 'GEARSET')]
        f = lambda lot: sim.scen.offset('OSM-AC-01', 'attr', 'gear_friction', {'GEARSET': lot})  # noqa: E731
        self.assertEqual(f(bad), 0.22)
        self.assertEqual(f('GEARSET-000000-001'), 0.0)
        sim.scenario('OSM-GEAR-LOT', False)
        self.assertNotEqual(sim.lots.cur['GEARSET'], bad, '시나리오를 끄면 불량 LOT를 격리하고 새 LOT로 바꾼다')
        self.assertEqual(f(bad), 0.0)

    def test_unknown_or_repeated_scenario_is_ignored(self):
        sim = Sim(FACTORY, io=None, realtime=False, seed=1)
        sim.scenario('NO-SUCH', True)
        self.assertEqual(sim.scen.active, {})
        sim.scenario('HL-MOLD-COOL', True)
        t0 = sim.scen.active['HL-MOLD-COOL']
        sim.env.run(until=100)
        sim.scenario('HL-MOLD-COOL', True)   # 이미 켜져 있으면 시작 시각을 바꾸지 않는다
        self.assertEqual(sim.scen.active['HL-MOLD-COOL'], t0)


class StationOps(unittest.TestCase):
    def test_operator_commands_drive_state(self):
        sim = Sim(FACTORY, io=None, realtime=False, seed=2)
        sim.env.run(until=300)
        st = sim.stations['HL-IM-L1']
        sim.station_op('HL-IM-L1', 'fail', '노즐 막힘')
        self.assertEqual(st.state, 'DOWN')
        self.assertIn('노즐 막힘', st.reason)
        sim.station_op('HL-IM-L1', 'repair')
        self.assertNotEqual(st.state, 'DOWN')
        sim.station_op('HL-IM-L1', 'setup', '금형 교체')
        self.assertEqual(st.state, 'SETUP', '셋업은 계획 정지(STOP)와 따로 센다')
        sim.station_op('HL-IM-L1', 'start')
        sim.station_op('HL-IM-L1', 'stop')
        self.assertEqual(st.state, 'STOP')
        sim.station_op('HL-IM-L1', 'start')
        sim.env.run(until=900)
        self.assertIn(st.state, ('RUN', 'IDLE', 'BLOCKED'))

    def warm_sim(self, prob: float = 1.0) -> Sim:
        factory = copy.deepcopy(FACTORY)
        for ln in factory['lines']:
            for sd in ln['stations']:
                if sd.get('warmup'):
                    sd['warmup']['prob'] = prob
        sim = Sim(factory, io=None, realtime=False, seed=4)
        sim.env.run(until=600)
        return sim

    def test_long_halt_makes_warmup_scrap(self):
        """오래 멈췄다 다시 돌리면 첫 몇 사이클이 초품 불량이 된다 (6대 로스의 초기 수율)"""
        sim = self.warm_sim()
        st = sim.stations['HL-IM-L1']
        w = st.d['warmup']
        sim.station_op('HL-IM-L1', 'fail')
        sim.env.run(until=600 + w['minHalt'] * 60 + 60)
        before = sim.stats.defects['HL-IM-L1'][w['defect']]
        sim.station_op('HL-IM-L1', 'repair')
        self.assertEqual(st.warm_left, w['shots'])
        sim.env.run(until=sim.env.now + st.d['cycle'] * (w['shots'] + 2) * 1.5)
        self.assertEqual(st.warm_left, 0)
        self.assertGreaterEqual(sim.stats.defects['HL-IM-L1'][w['defect']] - before, w['shots'])

    def test_short_halt_or_setup_release_order(self):
        sim = self.warm_sim()
        st = sim.stations['HL-IM-L1']
        # 잠깐(1분) 멈춘 것은 초품이 없다
        sim.station_op('HL-IM-L1', 'stop')
        sim.env.run(until=sim.env.now + 60)
        sim.station_op('HL-IM-L1', 'start')
        self.assertEqual(st.warm_left, 0)
        # 고장 중에 정지도 걸었다면 둘 다 풀려야 재가동이고, 멈춘 시간은 처음 멈춘 때부터 센다
        sim.station_op('HL-IM-L1', 'fail')
        sim.env.run(until=sim.env.now + 400)
        sim.station_op('HL-IM-L1', 'stop')
        sim.env.run(until=sim.env.now + 400)
        sim.station_op('HL-IM-L1', 'repair')
        self.assertEqual(st.warm_left, 0, '아직 정지 중')
        sim.station_op('HL-IM-L1', 'start')
        self.assertEqual(st.warm_left, st.d['warmup']['shots'])

    def test_downtime_is_counted(self):
        sim = Sim(FACTORY, io=None, realtime=False, seed=2)
        sim.env.run(until=600)
        sim.station_op('HL-IM-L1', 'fail')
        sim.env.run(until=1200)
        sim.station_op('HL-IM-L1', 'repair')
        sim.flush_stats()
        self.assertGreaterEqual(sim.stats.state_sec['HL-IM-L1']['DOWN'], 600 - 1e-6)


class QualityModel(unittest.TestCase):
    def test_defect_probability_threshold(self):
        z = {'tag:a': 0.0}
        drivers = [{'ref': 'tag:a', 'dir': 1, 'k': 1.0}]
        p0 = defect_probability(0.01, drivers, z.get)
        self.assertAlmostEqual(p0, 0.01, places=9, msg='문턱(1.5σ) 안이면 기본 불량률 그대로')
        z['tag:a'] = 1.4
        self.assertAlmostEqual(defect_probability(0.01, drivers, z.get), 0.01, places=9)
        z['tag:a'] = 3.5
        self.assertGreater(defect_probability(0.01, drivers, z.get), 0.05)
        z['tag:a'] = -3.5
        self.assertAlmostEqual(defect_probability(0.01, drivers, z.get), 0.01, places=9, msg='방향이 반대면 영향 없음')
        z['tag:a'] = 1e9
        self.assertLess(defect_probability(0.01, drivers, z.get), 0.9, msg='한 요인의 효과에는 상한이 있다')


class RealtimeClock(unittest.TestCase):
    """회귀: 오래 돌린 뒤 배속을 바꾸면 가상 시계가 수십 분 멈추던 버그 (simpy env.sync()가 env_start를 그대로 두었다)"""

    def fast_forward(self, hours: float) -> Sim:
        sim = Sim(FACTORY, io=None, speed=120, realtime=True, seed=1)
        sim.env._factor = 1e-6   # 테스트용: 실제 시간을 거의 쓰지 않고 몇 시간치를 돌린다
        resync_clock(sim.env)
        sim.env.run(until=hours * 3600)
        return sim

    def assert_clock_fresh(self, sim: Sim):
        env = sim.env
        self.assertAlmostEqual(env.env_start, env.now)
        self.assertLess(time.monotonic() - env.real_start, 1.0)

    def test_speed_change_after_long_run_does_not_stall(self):
        sim = self.fast_forward(4)
        sim.set_speed(5)
        self.assert_clock_fresh(sim)
        t0 = time.monotonic()
        sim.env.run(until=sim.env.now + 2)   # 가상 2초 = 5배속에서 실제 0.4초
        self.assertLess(time.monotonic() - t0, 3.0)

    def test_resume_after_pause_does_not_fast_forward(self):
        sim = self.fast_forward(1)
        sim.set_speed(5)
        sim.set_running(False)
        sim.env.real_start -= 120   # 일시정지한 채 2분이 지났다
        sim.set_running(True)
        self.assert_clock_fresh(sim)

    def test_resync_when_far_behind(self):
        sim = self.fast_forward(1)
        sim.set_speed(5)
        sim.env.real_start -= MAX_LAG_SEC + 30   # 절전 복귀 등으로 실제 시간이 앞서 갔다
        resync_if_behind(sim)
        self.assert_clock_fresh(sim)


if __name__ == '__main__':
    unittest.main()
