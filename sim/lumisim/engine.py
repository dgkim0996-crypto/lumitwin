"""이산사건 시뮬레이션 엔진 (SimPy).

- 설비마다 작업자 프로세스(슬롯 수만큼)가 앞 버퍼에서 부품을 꺼내 가공하고 뒤 버퍼에 넣는다.
- 고장(MTBF/MTTR)이 나면 가공 중인 작업을 멈추고 수리가 끝나면 남은 시간만큼 이어서 한다.
- 품질: 부품 속성이 공정을 따라 흐르고, 잠재 불량은 뒤 검사 공정에서 확률적으로 검출된다.
- 가상 시계: RealtimeEnvironment 배속(factor) 또는 오프라인(최대 속도).
"""
from __future__ import annotations

import math
import random
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from time import monotonic

import simpy
from simpy.rt import RealtimeEnvironment


def resync_clock(env: RealtimeEnvironment) -> None:
    """가상 시계와 실제 시계의 기준점을 둘 다 지금으로 맞춘다.

    simpy의 env.sync()는 real_start만 지금으로 바꾸고 env_start는 처음 값 그대로 둔다.
    그 뒤 step()은 (사건 시각 − env_start) × factor 만큼 실제 시간이 지나기를 기다리므로,
    한참 돌린 뒤 배속을 바꾸거나 밀린 시계를 맞추면 지나온 가상 시간 전체 × factor 동안 잠들어 버린다
    (예: 가상 4시간 돌린 뒤 60→5배속이면 약 48분 멈춤).
    """
    env.env_start = env.now
    env.real_start = monotonic()

from . import mqtt_io as T
from .model import defect_probability, linear, round_to

KST = timezone(timedelta(hours=9))

FAILURE_REASONS: dict[str, list[str]] = {
    'injection': ['금형 이물 감지', '취출 로봇 알람', '밴드 히터 단선', '유압 압력 저하', '노즐 막힘'],
    'tunnel-hardcoat': ['컨베이어 정지', '경화로 온도 알람', '코터 노즐 막힘', '클린룸 차압 저하'],
    'tunnel-paint': ['도장 로봇 알람', '컨베이어 정지', '건조로 온도 알람', '도료 공급 압력 저하'],
    'metallizer': ['진공 펌프 알람', '증착원 단선', '도어 인터록', 'RF 전원 알람'],
    'reflow': ['컨베이어 정지', '히터 알람', '질소 압력 저하'],
    'mounter': ['피더 에러', '노즐 막힘', '부품 인식 실패 연속', '테이프 끊김'],
    'printer': ['스텐실 인식 실패', '페이스트 부족', '클리닝 롤 소진'],
    'assembly-cell': ['협동로봇 보호 정지', '나사 공급기 막힘', '지그 센서 이상'],
    'actuator-cell': ['그리스 디스펜서 알람', '나사 공급기 막힘', '협동로봇 보호 정지'],
    'screw-cell': ['나사 공급기 막힘', '드라이버 토크 알람'],
    'router-cobot': ['스핀들 과부하', '집진기 알람', '협동로봇 보호 정지'],
    'packer': ['라벨 프린터 용지 소진', '협동로봇 보호 정지'],
}
DEFAULT_REASONS = ['설비 알람', '센서 이상', '안전 인터록 작동', '통신 오류']


def iso(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


class Item:
    """부품·제품 한 개. 시리얼·속성·잠재 불량·하위 부품을 들고 다닌다."""

    __slots__ = ('serial', 'item', 'line', 'attrs', 'latent', 'comps')

    def __init__(self, serial: str, item: str, line: str):
        self.serial = serial
        self.item = item
        self.line = line
        self.attrs: dict[str, float] = {}
        self.latent: set[str] = set()
        self.comps: list[str] = []


class Scenarios:
    """시나리오 주입. 효과는 (설비, 대상, 키) 별 오프셋으로 계산한다."""

    def __init__(self, sim: 'Sim', defs: list[dict]):
        self.sim = sim
        self.defs = {d['id']: d for d in defs}
        self.active: dict[str, float] = {}
        # (시나리오, 자재) → 그 시나리오가 들여온 불량 LOT
        self.bad_lot: dict[tuple[str, str], str] = {}
        self.index: dict[tuple, list[tuple[str, dict]]] = defaultdict(list)
        for d in defs:
            for e in d['effects']:
                self.index[(e['station'], e['target'], e.get('key'))].append((d['id'], e))

    def _lot_materials(self, sid: str) -> list[str]:
        return sorted({e['lot'] for e in self.defs[sid]['effects'] if e.get('lot')})

    def start(self, sid: str) -> bool:
        if sid not in self.defs or sid in self.active:
            return False
        self.active[sid] = self.sim.env.now
        for m in self._lot_materials(sid):
            self.bad_lot[(sid, m)] = self.sim.lots.force_new(m, '입고')
        return True

    def stop(self, sid: str) -> bool:
        if self.active.pop(sid, None) is None:
            return False
        for m in self._lot_materials(sid):
            bad = self.bad_lot.pop((sid, m), None)
            if bad and self.sim.lots.cur.get(m) == bad:
                self.sim.lots.force_new(m, f'{bad} 격리 후 교체')
        return True

    @staticmethod
    def _level(e: dict, dt: float) -> float:
        if e['mode'] == 'step':
            return float(e.get('amount', 0))
        v = e.get('rate', 0) * dt / 60.0
        lim = e.get('limit')
        if lim is None:
            return v
        return max(v, lim) if lim < 0 else min(v, lim)

    def offset(self, station: str, target: str, key: str | None = None, lots: dict[str, str] | None = None) -> float:
        """lots: 이번 부품이 쓴 자재 LOT. LOT 한정 효과는 불량 LOT를 쓴 부품에만 더한다"""
        hits = self.index.get((station, target, key))
        if not hits:
            return 0.0
        now = self.sim.env.now
        total = 0.0
        for sid, e in hits:
            t0 = self.active.get(sid)
            if t0 is None:
                continue
            m = e.get('lot')
            if m and (not lots or lots.get(m) != self.bad_lot.get((sid, m))):
                continue
            total += self._level(e, now - t0)
        return total

    def progress(self, sid: str) -> float:
        """0~1: 드리프트가 상한까지 얼마나 왔는지"""
        t0 = self.active.get(sid)
        if t0 is None:
            return 0.0
        levels = []
        for e in self.defs[sid]['effects']:
            if e['mode'] == 'step' or not e.get('limit'):
                levels.append(1.0)
            else:
                levels.append(min(1.0, abs(self._level(e, self.sim.env.now - t0) / e['limit'])))
        return max(levels) if levels else 0.0


class Lots:
    """구매 자재 LOT. lotSize만큼 쓰면 다음 LOT로 바뀐다."""

    def __init__(self, sim: 'Sim', materials: list[dict]):
        self.sim = sim
        self.defs = {m['code']: m for m in materials}
        self.cur: dict[str, str] = {}
        self.used: Counter = Counter()
        self.seq: dict[str, int] = {m['code']: sim.rng.randint(100, 700) for m in materials}

    def _next(self, code: str) -> str:
        self.seq[code] += 1
        self.cur[code] = f"{code}-{self.sim.sim_dt().astimezone(KST):%y%m%d}-{self.seq[code]:03d}"
        self.used[code] = 0
        return self.cur[code]

    def consume(self, code: str, qty: int) -> str:
        d = self.defs[code]
        if code not in self.cur or self.used[code] >= d['lotSize']:
            first = code not in self.cur
            self._next(code)
            if not first:
                self.sim.event('lot-change', f"{d['name']} LOT 교체 → {self.cur[code]}")
        self.used[code] += qty
        return self.cur[code]

    def force_new(self, code: str, why: str) -> str:
        """남은 양과 상관없이 지금 새 LOT로 바꾼다 (불량 LOT 입고·격리 시나리오)"""
        lot = self._next(code)
        self.sim.event('lot-change', f"{self.defs[code]['name']} LOT 교체({why}) → {lot}")
        return lot


class Station:
    def __init__(self, sim: 'Sim', line: dict, d: dict):
        self.sim, self.env, self.rng = sim, sim.env, sim.rng
        self.line = line['code']
        self.d = d
        self.code = d['code']
        self.kind = d['kind']
        self.step = sim.steps[(self.line, d['step'])]
        self.final = d['step'] == line['finalStep']
        self.utility = d['cycle'] <= 0
        self.tagdef = {t['key']: t for t in d['tags']}
        self.cont = [t for t in d['tags'] if t['mode'] == 'continuous']
        self.cyc = [t for t in d['tags'] if t['mode'] == 'cycle']
        self.values: dict[str, float] = {t['key']: float(t['nominal']) for t in d['tags']}
        self.state = 'RUN' if self.utility else 'IDLE'
        self.reason: str | None = None
        self.since = 0.0
        self.down = False
        self.stopped = False
        # 작업자가 세운 이유가 셋업(품종·금형 교체)이면 STOP 대신 SETUP으로 알린다 (OEE에서 계획 정지는 빼고 셋업은 손실로 센다)
        self.setup = False
        self.down_token = 0
        self.resume_ev = self.env.event()
        self.phase: dict[int, str] = {}
        self.procs: list = []
        self.out = sim.buffers[(self.line, d['step'])]
        self.slots = int(d.get('slots') or 1)
        self.batch = int(d.get('batch') or 1)
        self.loader = simpy.Resource(self.env, capacity=1) if self.slots > 1 else None

    # ── 시작 ──
    def start(self) -> None:
        if not self.utility:
            for i in range(self.slots):
                self.phase[i] = 'wait'
                self.procs.append(self.env.process(self.worker(i)))
        if self.d.get('mtbf'):
            self.env.process(self.failure_loop())

    # ── 상태 ──
    def compute_state(self) -> str:
        if self.stopped:
            return 'SETUP' if self.setup else 'STOP'
        if self.down:
            return 'DOWN'
        if self.utility:
            return 'RUN'
        ph = self.phase.values()
        if any(p == 'run' for p in ph):
            return 'RUN'
        if any(p == 'block' for p in ph):
            return 'BLOCKED'
        return 'IDLE'

    def refresh_state(self) -> None:
        s = self.compute_state()
        if s != self.state:
            self.sim.stats.state_change(self.code, self.state, self.env.now - self.since)
            self.state = s
            self.since = self.env.now
            msg = {'t': self.sim.now_iso(), 'state': s}
            if s in ('DOWN', 'STOP', 'SETUP') and self.reason:
                msg['reason'] = self.reason
            self.sim.publish(T.t_state(self.line, self.code), msg, qos=1)

    def set_phase(self, idx: int, p: str) -> None:
        self.phase[idx] = p
        self.refresh_state()

    def wait_ready(self):
        while self.down or self.stopped:
            yield self.resume_ev

    def _wake(self) -> None:
        ev, self.resume_ev = self.resume_ev, self.env.event()
        ev.succeed()

    # ── 고장·수리·정지 ──
    def fail(self, reason: str | None = None) -> None:
        if self.down:
            return
        self.down = True
        self.down_token += 1
        self.reason = reason or self.rng.choice(FAILURE_REASONS.get(self.kind, DEFAULT_REASONS))
        for idx, proc in enumerate(self.procs):
            if self.phase.get(idx) == 'run' and proc.is_alive:
                proc.interrupt('down')
        self.refresh_state()
        self.sim.event('failure', f'{self.d["name"]} 고장: {self.reason}', station=self.code)

    def repair(self) -> None:
        if not self.down:
            return
        self.down = False
        self.reason = None
        self._wake()
        self.refresh_state()
        self.sim.event('repair', f'{self.d["name"]} 수리 완료', station=self.code)

    def set_stopped(self, on: bool, reason: str | None = None, setup: bool = False) -> None:
        if self.stopped == on:
            return
        self.stopped = on
        if on:
            self.setup = setup
            self.reason = reason or ('셋업' if setup else '작업자 정지')
            for idx, proc in enumerate(self.procs):
                if self.phase.get(idx) == 'run' and proc.is_alive:
                    proc.interrupt('stop')
        else:
            self.setup = False
            self.reason = None
            self._wake()
        self.refresh_state()

    def failure_loop(self):
        mtbf = self.d['mtbf'] * 60.0
        mttr = self.d['mttr'] * 60.0
        sigma = 0.5
        mu = math.log(max(mttr, 1.0)) - sigma ** 2 / 2
        while True:
            yield self.env.timeout(self.rng.expovariate(1.0 / mtbf))
            if self.down or self.stopped:
                continue
            self.fail()
            token = self.down_token
            yield self.env.timeout(self.rng.lognormvariate(mu, sigma))
            if self.down and self.down_token == token:
                self.repair()

    # ── 신호 ──
    def zref(self, ref: str, item: Item | None, cyc: dict[str, float]) -> float:
        kind, _, name = ref.partition(':')
        if kind == 'tag':
            st, key = self, name
            if '.' in name:
                code, key = name.split('.', 1)
                st = self.sim.stations.get(code)
                if st is None:
                    return 0.0
            td = st.tagdef.get(key)
            if td is None:
                return 0.0
            v = cyc[key] if (st is self and key in cyc) else st.values.get(key, td['nominal'])
            return (v - td['nominal']) / (td['sd'] or 1.0)
        if kind == 'attr':
            if item is None or name not in item.attrs:
                return 0.0
            ad = self.sim.attrdefs.get(name)
            if ad is None:
                return 0.0
            return (item.attrs[name] - ad['base']) / (ad['sd'] or 1.0)
        return 0.0

    def update_tags(self, dt: float) -> None:
        """연속 태그를 dt초만큼 진행한다 (OU 과정: 정상 분산이 sd²가 되도록)."""
        scen = self.sim.scen
        halted = self.state in ('DOWN', 'STOP', 'SETUP')
        for t in self.cont:
            key = t['key']
            tau = t.get('tau') or 60.0
            a = math.exp(-dt / tau)
            target = float(t['idle']) if (halted and 'idle' in t) else float(t['nominal'])
            for term in t.get('terms', ()):
                target += term['coef'] * self.zref(term['ref'], None, {})
            target += scen.offset(self.code, 'tag', key)
            x = self.values[key]
            self.values[key] = target + (x - target) * a + self.rng.gauss(0.0, t['sd']) * math.sqrt(max(0.0, 1 - a * a))

    def sample_cycle_tags(self) -> dict[str, float]:
        out = {}
        for t in self.cyc:
            v = t['nominal'] + self.sim.scen.offset(self.code, 'tag', t['key'])
            if t['sd']:
                v += self.rng.gauss(0.0, t['sd'])
            out[t['key']] = v
        return out

    def sample_cycle(self) -> float:
        base = float(self.d['cycle'])
        cv = float(self.d.get('cycleCv') or 0.0)
        c = base * (1 + self.rng.gauss(0.0, cv)) + self.sim.scen.offset(self.code, 'cycle')
        return max(base * 0.5, c)

    # ── 가공 ──
    def take_inputs(self):
        sets = []
        for _ in range(self.batch):
            items: list[Item] = []
            lots: dict[str, str] = {}
            for inp in self.step['inputs']:
                qty = int(inp['qty'])
                if 'material' in inp:
                    lots[inp['material']] = self.sim.lots.consume(inp['material'], qty)
                elif 'step' in inp:
                    store = self.sim.buffers[(self.line, inp['step'])]
                    for _ in range(qty):
                        items.append((yield store.get()))
                elif 'transfer' in inp:
                    store = self.sim.inbound[inp['transfer']]
                    for _ in range(qty):
                        items.append((yield store.get()))
            sets.append((items, lots))
        return sets

    def worker(self, idx: int):
        env = self.env
        # 터널형 설비는 안이 이미 차 있는 상태로 시작한다 (슬롯마다 진행 정도를 고르게 나눈다)
        warm = self.loader is not None
        while True:
            yield from self.wait_ready()
            pre = warm
            if warm:
                warm = False
                src = self.step['inputs'][0]
                src_item = self.sim.steps[(self.line, src['step'])]['item'] if 'step' in src else self.step['item']
                sets = [([Item(self.sim.new_serial('WIP'), src_item, self.line)], {})]
                cycle = self.sample_cycle() * (idx + 1) / self.slots
                start = env.now
            else:
                self.set_phase(idx, 'wait')
                sets = yield from self.take_inputs()
                yield from self.wait_ready()
                cycle = self.sample_cycle()
                start = env.now
            if self.loader is not None and not pre:
                # 터널형: 입구에 한 개씩 피치 간격으로 들어간다
                with self.loader.request() as req:
                    yield req
                    yield env.timeout(cycle / self.slots)
            self.set_phase(idx, 'run')
            remaining = cycle - (env.now - start)
            while remaining > 1e-9:
                t0 = env.now
                try:
                    yield env.timeout(remaining)
                    remaining = 0.0
                except simpy.Interrupt:
                    remaining -= env.now - t0
                    self.set_phase(idx, 'hold')
                    yield from self.wait_ready()
                    self.set_phase(idx, 'run')
            outs = self.finish(sets, start, env.now - start)
            self.set_phase(idx, 'block')
            for it in outs:
                yield self.out.put(it)
            self.set_phase(idx, 'wait')

    def make_item(self, items: list[Item]) -> tuple[Item, list[Item]]:
        """이 공정의 결과 품목과 이번에 결합된 부품 목록"""
        step = self.step
        if step['serial'] == 'new' or not items:
            item = Item(self.sim.new_serial(step.get('prefix') or step['item'][:2]), step['item'], self.line)
            merged = items
        else:
            item = items[0]
            merged = items[1:]
        if merged:
            pools: dict[str, list[float]] = defaultdict(list)
            for src in ([item] if item not in merged else []) + merged:
                for k, v in src.attrs.items():
                    pools[k].append(v)
            for k, vs in pools.items():
                item.attrs[k] = sum(vs) / len(vs)
            for m in merged:
                item.latent |= m.latent
                item.comps.append(m.serial)
        item.item = step['item']
        return item, merged

    def finish(self, sets, start: float, cycle: float) -> list[Item]:
        d = self.d
        cyc = self.sample_cycle_tags()
        self.values.update(cyc)
        outs = []
        for items, lots in sets:
            item, merged = self.make_item(items)
            z = lambda ref, _it=item: self.zref(ref, _it, cyc)  # noqa: E731
            # 공정 조건 기록: 이번 사이클 값 + 그 순간의 연속 태그 (MES가 부품별로 남긴다)
            values = {k: round_to(v, self.tagdef[k].get('digits')) for k, v in self.values.items()}
            attrs_here = {}
            # 1) 부품 속성 계산
            for a in d.get('attrs', ()):
                v = linear(a['base'], a['terms'], z) + self.rng.gauss(0.0, a['sd'])
                v += self.sim.scen.offset(self.code, 'attr', a['key'], lots)
                item.attrs[a['key']] = v
                attrs_here[a['key']] = round_to(v, a.get('digits'))
            ng: str | None = None
            # 2) 이 공정의 불량 (즉시 판정 또는 잠재)
            for df in d.get('defects', ()):
                if self.rng.random() < defect_probability(df['base'], df['drivers'], z):
                    if df.get('latent'):
                        item.latent.add(df['code'])
                    elif ng is None:
                        ng = df['code']
            # 3) 검사 측정값
            for m in d.get('measures', ()):
                v = linear(m['base'], m['terms'], z) + self.rng.gauss(0.0, m['sd'])
                v += self.sim.scen.offset(self.code, 'measure', m['key'], lots)
                if m.get('lsl') is None and m['base'] > 0:
                    v = max(0.0, v)
                values[m['key']] = round_to(v, m.get('digits'))
                lo, hi = m.get('lsl'), m.get('usl')
                if ng is None and ((lo is not None and v < lo) or (hi is not None and v > hi)):
                    ng = m['defect']
            # 4) 잠재 불량 검출
            for det in d.get('detects', ()):
                code = det['defect']
                if code in item.latent and self.rng.random() < det['prob']:
                    item.latent.discard(code)
                    if ng is None:
                        ng = code
            msg = {
                't': self.sim.now_iso(), 'start': self.sim.iso_at(start), 'serial': item.serial, 'item': item.item,
                'step': d['step'], 'station': self.code, 'line': self.line, 'result': 'NG' if ng else 'OK',
                'values': values, 'cycle': round(cycle, 1),
            }
            if ng:
                msg['defect'] = ng
            if attrs_here:
                msg['attrs'] = attrs_here
            if merged:
                msg['comps'] = [m.serial for m in merged]
            if lots:
                msg['lots'] = lots
            if self.final and not ng and item.latent:
                msg['escaped'] = sorted(item.latent)
            self.sim.stats.unit(self.code, ng)
            self.sim.publish(T.t_unit(self.line, self.code), msg, qos=1)
            if not ng:
                outs.append(item)
        return outs

    def tags_payload(self) -> dict:
        v = {k: round_to(x, self.tagdef[k].get('digits')) for k, x in self.values.items()}
        msg = {'t': self.sim.now_iso(), 'v': v, 's': self.state}
        if self.state in ('DOWN', 'STOP') and self.reason:
            msg['r'] = self.reason
        return msg


class Amr:
    """이동식 협동로봇. 출발 버퍼에 lot만큼 쌓이면 싣고 경로를 따라 옮긴 뒤 되돌아온다."""

    MOVE_DRAIN = 0.5 / 60   # 주행 중 초당 배터리 소모 (%)
    IDLE_DRAIN = 0.05 / 60
    CHARGE_RATE = 1.3 / 60  # 초당 충전 (%) ≈ 10→90 % 약 60분

    def __init__(self, sim: 'Sim', d: dict, transfer: dict):
        self.sim, self.env = sim, sim.env
        self.d = d
        self.code = d['code']
        self.tr = transfer
        self.path = [tuple(p) for p in transfer['path']]
        self.x, self.z = self.path[0]
        self.heading = 0.0
        self.seg = None
        self.state = 'IDLE'
        self.battery = sim.rng.uniform(60, 100)
        self.load = 0

    def pose(self) -> tuple[float, float, float]:
        if self.seg:
            t0, t1, (x0, z0), (x1, z1) = self.seg
            f = 1.0 if t1 <= t0 else min(1.0, max(0.0, (self.env.now - t0) / (t1 - t0)))
            return x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, self.heading
        return self.x, self.z, self.heading

    def drive(self, points):
        speed = float(self.d['speed'])
        for p0, p1 in zip(points, points[1:]):
            dist = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            if dist < 1e-6:
                continue
            dur = dist / speed
            self.heading = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
            self.seg = (self.env.now, self.env.now + dur, p0, p1)
            yield self.env.timeout(dur)
            self.x, self.z = p1
            self.battery = max(0.0, self.battery - dur * self.MOVE_DRAIN)
        self.seg = None

    def run(self):
        env = self.env
        src = self.sim.buffers[(self.tr['from']['line'], self.tr['from']['step'])]
        to = self.tr['to']
        lot = int(self.tr['lot'])
        handle = float(self.d['handleSec'])
        while True:
            if self.battery < 25:
                self.state = 'CHARGING'
                while self.battery < 95:
                    yield env.timeout(60)
                    self.battery = min(100.0, self.battery + 60 * self.CHARGE_RATE)
            self.state = 'IDLE'
            waited = 0.0
            while len(src.items) < lot and not (len(src.items) > 0 and waited >= 900):
                yield env.timeout(20)
                waited += 20
                self.battery = max(0.0, self.battery - 20 * self.IDLE_DRAIN)
            self.state = 'LOADING'
            yield env.timeout(handle)
            n = min(lot, max(1, len(src.items)))
            items = []
            for _ in range(n):
                items.append((yield src.get()))
            self.load = len(items)
            self.state = 'MOVING'
            yield from self.drive(self.path)
            self.state = 'UNLOADING'
            yield env.timeout(handle)
            if 'warehouse' in to:
                for it in items:
                    self.sim.ship(it)
            else:
                dest = self.sim.inbound[self.tr['code']]
                for it in items:
                    yield dest.put(it)
            self.load = 0
            self.state = 'RETURNING'
            yield from self.drive(list(reversed(self.path)))

    def payload(self) -> dict:
        x, z, h = self.pose()
        return {
            't': self.sim.now_iso(), 'x': round(x, 2), 'z': round(z, 2), 'heading': round(h, 3), 'state': self.state,
            'transfer': self.tr['code'], 'battery': round(self.battery, 1), 'load': self.load,
        }


class Stats:
    """오프라인 보정용 집계 (실시간 모드에서도 가볍게 돈다)."""

    def __init__(self):
        self.ok: Counter = Counter()
        self.ng: Counter = Counter()
        self.defects: dict[str, Counter] = defaultdict(Counter)
        self.state_sec: dict[str, Counter] = defaultdict(Counter)

    def unit(self, station: str, ng: str | None) -> None:
        if ng:
            self.ng[station] += 1
            self.defects[station][ng] += 1
        else:
            self.ok[station] += 1

    def state_change(self, station: str, prev: str, dur: float) -> None:
        self.state_sec[station][prev] += dur


class Sim:
    def __init__(self, factory: dict, io=None, speed: float = 5.0, realtime: bool = True, seed: int | None = None, tick: float = 1.0):
        self.factory = factory
        self.io = io
        self.speed = float(speed)
        self.tick = tick
        self.realtime = realtime
        self.env = RealtimeEnvironment(factor=1.0 / self.speed, strict=False) if realtime else simpy.Environment()
        self.rng = random.Random(seed)
        self.start_dt = datetime.now(timezone.utc).replace(microsecond=0)
        self.running = True
        self.stats = Stats()
        self.serial_seq: Counter = Counter()
        self.warehouse: Counter = Counter()
        self.escaped: Counter = Counter()

        self.steps = {(ln['code'], s['code']): s for ln in factory['lines'] for s in ln['steps']}
        self.buffers = {k: simpy.Store(self.env, capacity=s['buffer']) for k, s in self.steps.items()}
        self.inbound = {
            t['code']: simpy.Store(self.env, capacity=max(60, t['lot'] * 3))
            for t in factory['transfers'] if 'line' in t['to']
        }
        self.attrdefs = {a['key']: a for ln in factory['lines'] for st in ln['stations'] for a in st.get('attrs', ())}
        self.scen = Scenarios(self, factory['scenarios'])
        self.lots = Lots(self, factory['materials'])
        self.stations: dict[str, Station] = {}
        for ln in factory['lines']:
            for sd in ln['stations']:
                self.stations[sd['code']] = Station(self, ln, sd)
        amr_defs = {a['code']: a for a in factory['amrs']}
        self.amrs = [Amr(self, amr_defs[t['amr']], t) for t in factory['transfers']]

        self.prefill()
        for st in self.stations.values():
            st.start()
        for a in self.amrs:
            self.env.process(a.run())
        self.telemetry_proc = self.env.process(self.telemetry())

    def prefill(self) -> None:
        """공장은 늘 돌고 있던 상태로 시작한다: 부품 공정 버퍼(용량 10 이상)와 이송 도착 버퍼를 절반쯤 채운다.
        초기 재공은 이력이 없으므로 시리얼 앞글자를 WIP로 둔다."""
        finals = {(ln['code'], ln['finalStep']) for ln in self.factory['lines']}
        for key, store in self.buffers.items():
            step = self.steps[key]
            if key in finals or step['buffer'] < 10:
                continue
            for _ in range(step['buffer'] // 2):
                store.items.append(Item(self.new_serial('WIP'), step['item'], key[0]))
        for code, store in self.inbound.items():
            tr = next(t for t in self.factory['transfers'] if t['code'] == code)
            src = self.steps[(tr['from']['line'], tr['from']['step'])]
            for _ in range(store.capacity * 2 // 3):
                store.items.append(Item(self.new_serial('WIP'), src['item'], tr['from']['line']))

    # ── 시각 ──
    def sim_dt(self, at: float | None = None) -> datetime:
        return self.start_dt + timedelta(seconds=self.env.now if at is None else at)

    def now_iso(self) -> str:
        return iso(self.sim_dt())

    def iso_at(self, at: float) -> str:
        return iso(self.sim_dt(at))

    def new_serial(self, prefix: str) -> str:
        self.serial_seq[prefix] += 1
        return f'{prefix}{self.sim_dt().astimezone(KST):%y%m%d}{self.serial_seq[prefix]:05d}'

    # ── 출력 ──
    def publish(self, topic: str, obj: dict, qos: int = 0) -> None:
        if self.io is not None:
            self.io.publish(topic, obj, qos=qos)

    def event(self, kind: str, message: str, station: str | None = None, scenario: str | None = None) -> None:
        msg = {'t': self.now_iso(), 'kind': kind, 'message': message}
        if station:
            msg['station'] = station
        if scenario:
            msg['scenario'] = scenario
        self.publish(T.T_EVENT, msg, qos=1)

    def ship(self, item: Item) -> None:
        self.warehouse[item.item] += 1
        for code in item.latent:
            self.escaped[code] += 1

    def status_payload(self) -> dict:
        return {
            't': self.now_iso(),
            'startedAt': iso(self.start_dt),
            'speed': self.speed,
            'running': self.running,
            'scenarios': [
                {'id': sid, 'startedAt': self.iso_at(t0), 'level': round(self.scen.progress(sid), 3)}
                for sid, t0 in self.scen.active.items()
            ],
            'buffers': {f'{ln}.{st}': len(store.items) for (ln, st), store in self.buffers.items()},
            'inbound': {code: len(store.items) for code, store in self.inbound.items()},
            'warehouse': dict(self.warehouse),
            'escaped': dict(self.escaped),
        }

    def telemetry(self):
        last = self.env.now
        while True:
            try:
                yield self.env.timeout(self.speed * self.tick if self.realtime else self.tick)
            except simpy.Interrupt:
                # 배속이 바뀌었다: 바로 한 번 보내고 새 간격으로 기다린다.
                # 안 그러면 60→5배속일 때 남은 가상 60초를 실제 12초 동안 기다려 MES가 연결이 끊긴 줄 안다
                pass
            dt = self.env.now - last
            last = self.env.now
            for st in self.stations.values():
                st.update_tags(dt)
            if self.io is not None:
                for st in self.stations.values():
                    self.io.publish(T.t_tags(st.line, st.code), st.tags_payload())
                for a in self.amrs:
                    self.io.publish(T.t_amr(a.code), a.payload())
                self.io.publish(T.T_STATUS, self.status_payload())

    def publish_status(self) -> None:
        """일시정지 중에도 상태를 보낸다. 안 보내면 MES가 시뮬레이터가 끊긴 줄 알고 재개 명령을 거절한다"""
        if self.io is not None:
            self.io.publish(T.T_STATUS, self.status_payload())

    # ── 명령 ──
    def set_speed(self, speed: float) -> None:
        self.speed = max(0.5, min(120.0, float(speed)))
        if self.realtime:
            self.env._factor = 1.0 / self.speed  # simpy.rt: factor는 읽기 전용 속성이라 내부 값을 바꾸고 다시 맞춘다
            resync_clock(self.env)
            if self.telemetry_proc.is_alive:
                self.telemetry_proc.interrupt('speed')
        self.event('speed', f'배속 {self.speed:g}배')

    def set_running(self, on: bool) -> None:
        if self.running == on:
            return
        self.running = on
        if on and self.realtime:
            resync_clock(self.env)
        self.event('resume' if on else 'pause', '시뮬레이션 재개' if on else '시뮬레이션 일시정지')

    def scenario(self, sid: str, on: bool) -> None:
        d = self.scen.defs.get(sid)
        if d is None:
            return
        if on and self.scen.start(sid):
            self.event('scenario-on', f'시나리오 시작: {d["name"]}', scenario=sid)
        elif not on and self.scen.stop(sid):
            self.event('scenario-off', f'시나리오 종료: {d["name"]}', scenario=sid)

    def station_op(self, code: str, op: str, reason: str | None = None) -> None:
        """작업자 명령. reason은 작업자 태블릿에서 고른 비가동 사유 (없으면 기본 문구)"""
        st = self.stations.get(code)
        if st is None:
            return
        if op == 'stop':
            st.set_stopped(True, reason)
        elif op == 'setup':
            st.set_stopped(True, reason, setup=True)
        elif op == 'start':
            st.set_stopped(False)
        elif op == 'repair':
            st.repair()
        elif op == 'fail':
            st.fail(f'{reason} (작업자 등록)' if reason else '작업자 고장 등록')

    def flush_stats(self) -> None:
        for st in self.stations.values():
            self.stats.state_change(st.code, st.state, self.env.now - st.since)
            st.since = self.env.now
