"""이산사건 시뮬레이션 엔진 (SimPy).

- 설비마다 작업자 프로세스(슬롯 수만큼)가 앞 버퍼에서 부품을 꺼내 가공하고 뒤 버퍼에 넣는다.
- 고장(MTBF/MTTR)이 나면 가공 중인 작업을 멈추고 수리가 끝나면 남은 시간만큼 이어서 한다.
- 품질: 부품 속성이 공정을 따라 흐르고, 잠재 불량은 뒤 검사 공정에서 확률적으로 검출된다.
- 가상 시계: RealtimeEnvironment 배속(factor) 또는 오프라인(최대 속도).

실행 MES (P9) — 시뮬레이터 쪽 흐름 (계약: shared/src/live.ts · mes.ts)
- 작업지시: 투입 공정(line.release)은 작업지시가 남아 있을 때만 투입한다. 없으면 MES에 요청하고 '생산 계획 없음'으로 선다.
  기종이 바뀌면 line.changeover 설비가 새 기종 첫 개체를 받을 때 셋업한다 (투입 공정부터 물결처럼).
- 인터록: 게이트 설비는 투입 순간 MES에 확인을 묻고 사이클과 겹쳐 기다린다. NG면 투입 묶음을 격리 구역으로 보낸다.
- 불량 처리: 제품 경로의 NG 개체는 불량 대기에 두고 MES 판정(disposition)을 따른다 (수리대 → 되돌림 줄 → 재검사).
- 4M 변경점·초중종물, 예지 보전(마모·상태 감시·계획 보전), 연배 분할(split).
- io가 없으면(오프라인·테스트) 인터록을 하지 않고, 작업지시는 스스로 만들고, 불량 판정은 기본 규칙(ngRule)을 쓴다.
"""
from __future__ import annotations

import math
import os
import random
from collections import Counter, defaultdict, deque
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
from .model import defect_probability, iso, linear, mes_table, round_to

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

# ── 실행 MES (P9) 시뮬레이터 쪽 상수 ──
ILK_WAIT_REASON = 'MES 확인 대기'
# 인터록 응답이 연달아 이만큼 시간 초과면 MES가 멈춘 것으로 보고, 응답이 다시 올 때까지 사이클 뒤에 더 기다리지 않는다
# (확인 없이 통과 · ilkSkip). 매 사이클 몇 초씩 기다리면 MES가 꺼진 동안 라인 속도가 절반 아래로 떨어진다 (assumed)
ILK_BYPASS_AFTER = 3
# 작업지시 응답이 없을 때 다시 묻는 간격 (실제 초, 계약 2.1)
WO_RETRY_SEC = 5.0
# 마모 결합 (계약 2.6): 0.8을 넘으면 고장률이 최대 약 10배까지 커진다 · 그 고장의 사유
WEAR_HIGH = 0.8
WEAR_FAIL_MAX = 9.0  # 기본 고장률에 더하는 배수 (마모 1에서 합쳐 10배)
WEAR_REASON = '이음·진동'
WEAR_AFTER_REPAIR = 0.1
WEAR_AFTER_PM = 0.05
# 실행 시작 때 마모 (설비별 흩뿌림, assumed): 0~0.3에서 고른다. 마모 속도는 설비별 ±20 %
WEAR_START = (0.0, 0.3)
WEAR_RATE_SPREAD = 0.2
VIB_WEAR_GAIN = 6.0  # 가동 중 진동 = vib0 · (1 + 6 · 마모²) (계약 2.6)
AMBIENT_C = 25.0  # 공장 실내 온도 (assumed)
TEMP_TAU_SEC = 900.0  # 베어링·모터 온도 시정수 (assumed)
# 수리대 작업 시간 흩뿌림 (변동계수, assumed)
REPAIR_CV = 0.2


class Item:
    """부품·제품 한 개. 시리얼·속성·잠재 불량·하위 부품을 들고 다닌다.

    variant·wo·wo_last: 투입 공정부터 제품에 붙는 기종·작업지시. init: 처음부터 있던 재공(MES가 아직 모르는 시리얼)
    """

    __slots__ = ('serial', 'item', 'line', 'attrs', 'latent', 'comps', 'variant', 'wo', 'wo_last', 'init')

    def __init__(self, serial: str, item: str, line: str, init: bool = False):
        self.serial = serial
        self.item = item
        self.line = line
        self.attrs: dict[str, float] = {}
        self.latent: set[str] = set()
        self.comps: list[str] = []
        self.variant: str | None = None
        self.wo: int | None = None
        self.wo_last = False
        self.init = init


class Load:
    """설비가 한 번에 투입한 묶음: 주 개체·부품·자재 LOT와 실행 MES 표시.

    serial: 새로 발번하는 공정이면 투입할 때 미리 매긴 시리얼 (인터록 요청·격리에 쓴다)
    whole: 이미 조립된 개체를 다시 가공할 때 (수리 뒤 재검사). 새로 발번하거나 부품을 다시 소비하지 않는다
    back: 되돌림 줄로 돌아온 묶음 (격리 해제·수리 뒤)
    """

    __slots__ = ('items', 'lots', 'serial', 'whole', 'variant', 'wo', 'wo_last', 'fa', 'fa_id', 'reinspect', 'skip', 'back')

    def __init__(self, items: list[Item], lots: dict[str, str], serial: str | None = None, whole: Item | None = None):
        self.items = items
        self.lots = lots
        self.serial = serial
        self.whole = whole
        src = whole or next((it for it in items if it.variant), None)
        self.variant = src.variant if src else None
        self.wo = src.wo if src else None
        self.wo_last = bool(src.wo_last) if src else False
        self.fa = False
        self.fa_id: str | None = None
        self.reinspect = False
        self.skip = False
        self.back = False

    def main_serial(self) -> str:
        if self.whole is not None:
            return self.whole.serial
        if self.serial:
            return self.serial
        return self.items[0].serial if self.items else ''

    def comp_items(self) -> list[Item]:
        """주 개체가 아닌 하위 부품"""
        if self.whole is not None:
            return []
        return self.items if self.serial else self.items[1:]

    def unknown_main(self) -> bool:
        """주 개체가 MES가 모르는 처음 재공이면 인터록을 묻지 않는다 (이력이 없어 공정 순서 판정을 못 한다)"""
        if self.whole is not None:
            return self.whole.init
        return not self.serial and bool(self.items) and self.items[0].init

    def serials(self) -> list[str]:
        out = [self.main_serial()]
        out += [it.serial for it in self.items if it.serial not in out]
        return out


class IlkReq:
    """인터록 요청 하나 (응답이 오면 ev가 울린다)"""

    __slots__ = ('rid', 'load', 'ev', 'verdict', 'code', 'reason')

    def __init__(self, rid: str, load: Load, ev):
        self.rid = rid
        self.load = load
        self.ev = ev
        self.verdict: str | None = None
        self.code: str | None = None
        self.reason: str | None = None


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
        """남은 양과 상관없이 지금 새 LOT로 바꾼다 (불량 LOT 입고·격리 시나리오·LOT Hold)"""
        lot = self._next(code)
        self.sim.event('lot-change', f"{self.defs[code]['name']} LOT 교체({why}) → {lot}")
        return lot


class LineExec:
    """라인 실행 상태: 작업지시·기종, 불량 대기·수리대·격리 구역 개수 (P9)"""

    def __init__(self, sim: 'Sim', ln: dict):
        self.sim, self.env = sim, sim.env
        self.code = ln['code']
        self.release = ln.get('release')
        self.variants = [v['code'] for v in ln.get('variants') or ()]
        self.vcycle = {v['code']: v.get('cycle') or {} for v in ln.get('variants') or ()}
        self.changeover = {c['station']: c for c in ln.get('changeover') or ()}
        # 작업지시
        self.wo: dict | None = None
        self.released = 0
        self.variant: str | None = None
        self.waiting = False
        self.ask_gen = 0
        self.reqs: set[str] = set()
        self.finished: dict | None = None
        self.done_ids: set[int] = set()
        self.local_n = 0
        self.wo_ev = None
        self.noplan_told = False
        # 불량 처리·격리
        self.desk = simpy.Resource(self.env, capacity=max(1, int(sim.mes.get('repairTechs') or 1)))
        self.pen_n = 0
        self.repair_n = 0
        self.quar_n = 0
        self.repaired = 0
        self.scrapped = 0

    # ── 작업지시 ──
    def has_wo(self) -> bool:
        return self.wo is not None and self.released < int(self.wo['qty'])

    def wo_signal(self):
        if self.wo_ev is None or self.wo_ev.triggered:
            self.wo_ev = self.env.event()
        return self.wo_ev

    def need_wo(self) -> None:
        """투입할 작업지시가 없다: MES에 묻는다 (오프라인이면 스스로 만든다)"""
        if self.waiting or self.has_wo() or not self.release:
            return
        self.waiting = True
        if self.sim.io is None:
            self.assign(self.local_wo())
            return
        self.ask_gen += 1
        self.env.process(self.ask(self.ask_gen))

    def ask(self, gen: int):
        while self.waiting and self.ask_gen == gen:
            rid = self.sim.next_rid('W')
            self.reqs.add(rid)
            msg = {'t': self.sim.now_iso(), 'reqId': rid, 'line': self.code}
            if self.finished:
                msg['finished'] = self.finished
            self.sim.publish(T.t_wo_req(self.code), msg, qos=1)
            yield self.env.timeout(self.sim.virtual(WO_RETRY_SEC))

    def on_wo_res(self, msg: dict) -> None:
        if not self.waiting or msg.get('reqId') not in self.reqs:
            return
        wo = msg.get('wo')
        try:
            ok = isinstance(wo, dict) and int(wo['id']) not in self.done_ids and int(wo.get('qty') or 0) > 0
        except (KeyError, TypeError, ValueError):
            print(f'[sim] 작업지시 응답 형식 오류: {wo!r}'[:120], flush=True)
            ok = False
        if not ok:
            if not self.noplan_told:
                self.noplan_told = True
                self.sim.event('wo', f'{self.code} 라인 {self.sim.mes["noPlanReason"]} · 투입 정지')
            return
        self.assign(wo)

    def local_wo(self) -> dict:
        """오프라인 자동 작업지시: 기종을 번갈아 woLot씩"""
        self.local_n += 1
        v = self.variants[(self.local_n - 1) % len(self.variants)] if self.variants else None
        qty = int((self.sim.mes.get('woLot') or {}).get(self.code, 100))
        return {'id': self.local_n, 'code': f'LOCAL-{self.code}-{self.local_n:03d}', 'variant': v, 'qty': qty}

    def assign(self, wo: dict) -> None:
        self.wo = {'id': int(wo['id']), 'code': str(wo.get('code') or wo['id']), 'variant': wo.get('variant'), 'qty': int(wo.get('qty') or 0)}
        self.released = 0
        self.variant = self.wo['variant'] or self.variant
        self.waiting = False
        self.reqs.clear()
        self.finished = None
        self.noplan_told = False
        self.sim.event('wo', f'{self.code} 작업지시 시작 {self.wo["code"]} · {self.wo["variant"] or "-"} {self.wo["qty"]}개')
        if self.wo_ev is not None and not self.wo_ev.triggered:
            self.wo_ev.succeed()

    def release_one(self, load: Load) -> None:
        """투입 공정이 한 개 투입했다: 기종·작업지시를 싣고, 다 넣었으면 다음 작업지시를 요청한다"""
        wo = self.wo
        self.released += 1
        load.variant, load.wo = wo['variant'], wo['id']
        if self.released >= int(wo['qty']):
            load.wo_last = True
            self.close_wo('투입 완료')

    def close_wo(self, why: str) -> None:
        wo = self.wo
        if wo is None:
            return
        self.finished = {'id': wo['id'], 'released': self.released}
        self.done_ids.add(wo['id'])
        self.sim.event('wo', f'{self.code} 작업지시 {why} {wo["code"]} · {self.released}/{wo["qty"]}개')
        self.wo = None
        self.need_wo()

    def cancel(self, wo_id: int) -> None:
        self.done_ids.add(wo_id)
        if self.wo is not None and self.wo['id'] == wo_id:
            self.close_wo('중단')

    # ── 불량 처리: 수리대 ──
    def repair(self, st: 'Station', item: Item, defect: str, action: str):
        sim = self.sim
        rule = sim.ng_rule(st.code, defect)
        self.repair_n += 1
        with self.desk.request() as req:
            yield req
            nominal = float(rule.get('minutes') or 10)
            minutes = max(nominal * 0.3, nominal * (1 + sim.xrng.gauss(0.0, REPAIR_CV)))
            yield self.env.timeout(minutes * 60)
        self.repair_n -= 1
        ok = sim.xrng.random() < float(rule.get('prob') if rule.get('prob') is not None else 0.85)
        msg = {'t': sim.now_iso(), 'line': self.code, 'serial': item.serial, 'defect': defect, 'action': action, 'ok': ok, 'minutes': round(minutes, 1)}
        if ok:
            msg['backTo'] = st.code
        sim.publish(T.t_repair(self.code), msg, qos=1)
        if not ok:
            self.scrapped += 1
            return
        self.repaired += 1
        # 고친 개체: 그 불량을 없애고 부품 속성을 기준값으로 되돌린다 (재작업으로 규격 안에 들인다)
        item.latent.discard(defect)
        for k in item.attrs:
            ad = sim.attrdefs.get(k)
            if ad is not None:
                item.attrs[k] = float(ad['base'])
        ld = Load([], {}, whole=item)
        ld.reinspect = True
        ld.back = True
        st.push_return(ld)

    def status(self) -> dict:
        wo = dict(self.wo, released=self.released) if self.wo else None
        return {
            'wo': wo,
            'variant': self.wo['variant'] if self.wo else self.variant,
            'waitingWo': self.waiting,
            'ngPen': self.pen_n,
            'repair': self.repair_n,
            'quarantine': self.quar_n,
        }


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
        self.down_reason: str | None = None
        self.stopped = False
        self.stop_reason: str | None = None
        # 작업자가 세운 이유가 셋업(품종·금형 교체)이면 STOP 대신 SETUP으로 알린다 (OEE에서 계획 정지는 빼고 셋업은 손실로 센다)
        self.setup = False
        # 재가동 초품: 멈추기 시작한 가상 시각과, 다시 돈 뒤 남은 불안정 사이클 수
        self.halt_at: float | None = None
        self.warm_left = 0
        self.down_token = 0
        self.resume_ev = self.env.event()
        self.phase: dict[int, str] = {}
        self.procs: list = []
        self.out = sim.buffers[(self.line, d['step'])]
        self.slots = int(d.get('slots') or 1)
        self.batch = int(d.get('batch') or 1)
        self.split = max(1, int(self.step.get('split') or 1))
        self.loader = simpy.Resource(self.env, capacity=1) if self.slots > 1 else None

        # ── 실행 MES (P9) ──
        mi = sim.mes['stations'].get(self.code) or {}
        self.lx: LineExec = sim.lines[self.line]
        self.fa_req = bool(mi.get('faRequired'))
        self.scope = bool(mi.get('productScope'))
        self.gate = bool(d.get('gate'))
        self.ilk_on = self.gate and sim.io is not None and not self.utility
        self.is_release = bool(self.lx.release) and d['step'] == self.lx.release
        self.co = self.lx.changeover.get(self.code)
        self.cur_variant: str | None = None
        self.co_reason: str | None = None
        # 되돌림 줄: 수리 뒤 재검사·격리 해제된 묶음. 제품 경로·게이트 설비만 받는다
        self.returns: deque | None = deque() if (self.scope or self.gate) and not self.utility else None
        self.ret_ev = None
        # 초물: 대기 중인 변경점 id, 지금 가공 중인 초물이 있는가, 이 설비의 마지막 변경점 id
        self.fa_change: str | None = None
        self.fa_busy = False
        self.fa_last: str | None = None
        self.mid_sec = float(sim.mes.get('midInspectHours') or 4) * 3600
        self.next_mid = self.mid_sec
        self.last_unit: tuple | None = None
        self.last_lots: dict[str, str] = {}
        # 계획 보전
        self.pm = False
        # 예지 보전: health가 정의된 설비만 마모를 쌓는다
        self.health = d.get('health')
        self.wear = 0.0
        self.wear_rate = 0.0
        self.temp = 0.0
        if self.health:
            self.wear = sim.xrng.uniform(*WEAR_START)
            hours = float(self.health.get('wearHours') or 1000)
            self.wear_rate = (1 + sim.xrng.uniform(-WEAR_RATE_SPREAD, WEAR_RATE_SPREAD)) / (hours * 3600)
            self.temp = float(self.health['temp']) + 18 * self.wear

    # ── 시작 ──
    def start(self) -> None:
        if not self.utility:
            for i in range(self.slots):
                self.phase[i] = 'wait'
                self.procs.append(self.env.process(self.worker(i)))
        if self.d.get('mtbf'):
            self.env.process(self.failure_loop())

    # ── 상태 ──
    def compute_state(self) -> tuple[str, str | None]:
        if self.stopped:
            return ('SETUP' if self.setup else 'STOP'), self.stop_reason
        if self.down:
            return 'DOWN', self.down_reason
        if self.pm:
            return 'STOP', self.sim.mes['pmReason']
        if self.utility:
            return 'RUN', None
        ph = self.phase.values()
        if 'run' in ph:
            return 'RUN', None
        if 'setup' in ph:
            return 'SETUP', self.co_reason
        if 'block' in ph:
            return 'BLOCKED', None
        if 'ilk' in ph:
            return 'IDLE', ILK_WAIT_REASON
        if 'noplan' in ph:
            return 'STOP', self.sim.mes['noPlanReason']
        return 'IDLE', None

    def refresh_state(self) -> None:
        s, r = self.compute_state()
        if s != self.state or r != self.reason:
            self.sim.stats.state_change(self.code, self.state, self.env.now - self.since)
            self.state, self.reason = s, r
            self.since = self.env.now
            msg = {'t': self.sim.now_iso(), 'state': s}
            if r:
                msg['reason'] = r
            self.sim.publish(T.t_state(self.line, self.code), msg, qos=1)

    def set_phase(self, idx: int, p: str) -> None:
        self.phase[idx] = p
        self.refresh_state()

    def wait_ready(self):
        while self.down or self.stopped or self.pm:
            yield self.resume_ev

    def _wake(self) -> None:
        ev, self.resume_ev = self.resume_ev, self.env.event()
        ev.succeed()

    def _halt(self) -> None:
        if self.halt_at is None:
            self.halt_at = self.env.now

    def _interrupt_running(self, cause: str) -> None:
        for idx, proc in enumerate(self.procs):
            if self.phase.get(idx) == 'run' and proc.is_alive:
                proc.interrupt(cause)

    def _resume_from_halt(self) -> None:
        """고장·정지·보전이 모두 풀렸을 때: 오래 멈췄으면 처음 몇 사이클을 불안정 구간으로 둔다"""
        if self.down or self.stopped or self.pm or self.halt_at is None:
            return
        w = self.d.get('warmup')
        if w and self.env.now - self.halt_at >= w['minHalt'] * 60:
            self.warm_left = int(w['shots'])
        self.halt_at = None

    # ── 고장·수리·정지·보전 ──
    def fail(self, reason: str | None = None) -> None:
        if self.down:
            return
        self.down = True
        self.down_token += 1
        self._halt()
        self.down_reason = reason or self.rng.choice(FAILURE_REASONS.get(self.kind, DEFAULT_REASONS))
        self._interrupt_running('down')
        self.refresh_state()
        self.sim.event('failure', f'{self.d["name"]} 고장: {self.down_reason}', station=self.code)

    def repair(self) -> None:
        if not self.down:
            return
        why = self.down_reason
        self.down = False
        self.down_reason = None
        # 마모로 난 고장이거나 마모가 이미 큰 설비를 열었으면 닳은 부품을 바꾼다
        if self.health and (why == WEAR_REASON or self.wear >= WEAR_HIGH):
            self.wear = WEAR_AFTER_REPAIR
        self._resume_from_halt()
        self._wake()
        self.refresh_state()
        self.sim.event('repair', f'{self.d["name"]} 수리 완료', station=self.code)
        self.sim.change_point(self, 'MACHINE', 'repair', f'고장 수리 뒤 재가동 ({why})', self.fa_req)

    def set_stopped(self, on: bool, reason: str | None = None, setup: bool = False) -> None:
        if self.stopped == on:
            return
        self.stopped = on
        if on:
            self.setup = setup
            self.stop_reason = reason or ('셋업' if setup else '작업자 정지')
            self._halt()
            self._interrupt_running('stop')
        else:
            self.setup = False
            self.stop_reason = None
            self._resume_from_halt()
            self._wake()
        self.refresh_state()

    def start_pm(self) -> None:
        """계획·예지 보전: pmMinutes 동안 세웠다가 스스로 재가동하고 마모를 되돌린다"""
        if self.pm:
            return
        minutes = float((self.sim.mes.get('pmMinutes') or {}).get(self.code, 20))
        self.pm = True
        self._halt()
        self._interrupt_running('pm')
        self.refresh_state()
        self.sim.event('pm', f'{self.d["name"]} {self.sim.mes["pmReason"]} 시작 ({minutes:g}분)', station=self.code)
        self.env.process(self._pm_done(minutes))

    def _pm_done(self, minutes: float):
        yield self.env.timeout(minutes * 60)
        before = self.wear
        if self.health:
            self.wear = WEAR_AFTER_PM
        self.pm = False
        self._resume_from_halt()
        self._wake()
        self.refresh_state()
        what = f'{self.health["part"]} 점검·교체' if self.health and self.health.get('part') else '점검'
        tail = f' · 마모 {before:.2f}→{self.wear:.2f}' if self.health else ''
        self.sim.change_point(self, 'MACHINE', 'pm', f'{self.sim.mes["pmReason"]} 실시 ({what}){tail}', self.fa_req)
        self.sim.event('pm', f'{self.d["name"]} {self.sim.mes["pmReason"]} 완료{tail}', station=self.code)

    def failure_loop(self):
        mtbf = self.d['mtbf'] * 60.0
        while True:
            yield self.env.timeout(self.rng.expovariate(1.0 / mtbf))
            if self.down or self.stopped or self.pm:
                continue
            self.fail()
            yield from self._repair_after(self.down_token, self.rng)

    def _repair_after(self, token: int, rng: random.Random):
        mttr = self.d['mttr'] * 60.0
        sigma = 0.5
        mu = math.log(max(mttr, 1.0)) - sigma ** 2 / 2
        yield self.env.timeout(rng.lognormvariate(mu, sigma))
        if self.down and self.down_token == token:
            self.repair()

    # ── 예지 보전 ──
    def health_tick(self, dt: float) -> None:
        """마모를 가동 시간만큼 쌓고, 온도를 따라가게 하고, 마모가 크면 고장 확률을 올린다"""
        h = self.health
        run = self.state == 'RUN'
        if run and self.wear < 1.0:
            speed = 1.0 + self.sim.scen.offset(self.code, 'wear')
            self.wear = min(1.0, self.wear + dt * self.wear_rate * max(0.0, speed))
        target = float(h['temp']) + 18 * self.wear if run else AMBIENT_C + (float(h['temp']) - AMBIENT_C) * 0.4
        self.temp = target + (self.temp - target) * math.exp(-dt / TEMP_TAU_SEC)
        if run and self.wear > WEAR_HIGH and not (self.down or self.stopped or self.pm):
            x = min(1.0, (self.wear - WEAR_HIGH) / (1.0 - WEAR_HIGH))
            lam = WEAR_FAIL_MAX * x * x / (float(self.d.get('mtbf') or 1440) * 60.0)
            if self.sim.xrng.random() < 1.0 - math.exp(-lam * dt):
                self.fail(WEAR_REASON)
                self.env.process(self._repair_after(self.down_token, self.sim.xrng))

    def health_payload(self) -> dict:
        h, w, r = self.health, self.wear, self.sim.xrng
        if self.state == 'RUN':
            # 진동은 마모 1에서 7배 (신품 A/B 구역 → ISO 10816 C/D 위험 구역까지 닿게, 계약 2.6 수정)
            vib = float(h['vib']) * (1 + VIB_WEAR_GAIN * w * w) * (1 + r.gauss(0.0, 0.04))
            cur = float(h['cur']) * (1 + 0.25 * w) * (1 + r.gauss(0.0, 0.02))
        else:
            vib = float(h['vib']) * 0.1 * (1 + r.gauss(0.0, 0.1))
            cur = float(h['cur']) * 0.08 * (1 + r.gauss(0.0, 0.1))
        temp = self.temp + r.gauss(0.0, 0.3)
        return {'t': self.sim.now_iso(), 'v': {'vib': round(max(0.0, vib), 2), 'cur': round(max(0.0, cur), 2), 'temp': round(temp, 1)}}

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

    def sample_cycle(self, variant: str | None = None) -> float:
        base = float(self.d['cycle'])
        if variant:
            base *= float(self.lx.vcycle.get(variant, {}).get(self.code, 1.0))
        cv = float(self.d.get('cycleCv') or 0.0)
        c = base * (1 + self.rng.gauss(0.0, cv)) + self.sim.scen.offset(self.code, 'cycle')
        return max(base * 0.5, c)

    # ── 투입 ──
    def ret_signal(self):
        if self.ret_ev is None or self.ret_ev.triggered:
            self.ret_ev = self.env.event()
        return self.ret_ev

    def push_return(self, load: Load) -> None:
        """되돌림 줄에 넣는다. 설비는 다음 투입 때 입력 버퍼보다 먼저 본다"""
        if self.returns is None:
            self.returns = deque()
        self.returns.append(load)
        if self.ret_ev is not None and not self.ret_ev.triggered:
            self.ret_ev.succeed()

    def use_lot(self, material: str, qty: int) -> str:
        lot = self.sim.lots.consume(material, qty)
        old = self.last_lots.get(material)
        self.last_lots[material] = lot
        if old is not None and old != lot:
            self.sim.change_point(self, 'MATERIAL', 'lot', f'{material} LOT {old} → {lot}', self.fa_req)
        return lot

    def get_or_return(self, store):
        """입력 버퍼에서 하나 꺼낸다. 기다리는 동안 되돌림 줄에 묶음이 오면 꺼내기를 그만두고 None"""
        ev = store.get()
        if not ev.triggered:
            yield ev | self.ret_signal()
            if not ev.triggered:
                ev.cancel()
                return None
        return (yield ev)

    def take_one(self, first: bool):
        step = self.step
        items: list[Item] = []
        for inp in step['inputs']:
            if 'material' in inp:
                continue
            store = self.sim.buffers[(self.line, inp['step'])] if 'step' in inp else self.sim.inbound[inp['transfer']]
            for _ in range(int(inp['qty'])):
                if first and not items and self.returns is not None:
                    it = yield from self.get_or_return(store)
                    if it is None:
                        return None
                else:
                    it = yield store.get()
                items.append(it)
        # 자재는 부품을 다 꺼낸 뒤 쓴다 (꺼내다 그만두면 자재를 헛되이 쓰지 않게)
        lots: dict[str, str] = {}
        for inp in step['inputs']:
            if 'material' in inp:
                lots[inp['material']] = self.use_lot(inp['material'], int(inp['qty']))
        serial = self.sim.new_serial(step.get('prefix') or step['item'][:2]) if step['serial'] == 'new' else None
        return Load(items, lots, serial=serial)

    def wait_wo(self, idx: int, allow_return: bool = True):
        """투입 공정: 작업지시가 생길 때까지 '생산 계획 없음'으로 선다. 되돌림이 오면 False"""
        lx = self.lx
        while not lx.has_wo():
            lx.need_wo()
            if lx.has_wo():
                break
            self.set_phase(idx, 'noplan')
            evs = [lx.wo_signal()]
            if allow_return and self.returns is not None:
                evs.append(self.ret_signal())
            yield simpy.AnyOf(self.env, evs)
            if allow_return and self.returns:
                return False
        return True

    def take(self, idx: int):
        if self.returns:
            return [self.returns.popleft()]
        if self.is_release:
            ok = yield from self.wait_wo(idx)
            if not ok:
                return None
            self.set_phase(idx, 'wait')
        loads: list[Load] = []
        for b in range(self.batch):
            if b and self.is_release and not self.lx.has_wo():
                break
            ld = yield from self.take_one(first=(b == 0))
            if ld is None:
                return None
            if self.is_release:
                # 부품을 꺼내는 사이 작업지시가 끝났거나 중단됐으면 다음 것을 기다린다
                if not self.lx.has_wo():
                    while not self.lx.has_wo():
                        yield from self.wait_wo(idx, allow_return=False)
                    self.set_phase(idx, 'wait')
                self.lx.release_one(ld)
            loads.append(ld)
        return loads

    def prepare(self, idx: int, loads: list[Load]):
        """가공 전: 기종이 바뀌었으면 셋업하고, 초물 대기가 있으면 이 개체를 초물로 삼는다"""
        v = loads[0].variant
        if v:
            old, self.cur_variant = self.cur_variant, v
            if self.co and old and old != v:
                yield from self.changeover(idx, old, v)
        if self.fa_change is not None and not self.fa_busy:
            ld = loads[0]
            ld.fa, ld.fa_id = True, self.fa_change
            self.fa_busy = True

    def changeover(self, idx: int, old: str, new: str):
        minutes = float(self.co.get('minutes') or 0)
        self.co_reason = f'기종 변경 {short_variant(old)}→{short_variant(new)}'
        self.sim.event('changeover', f'{self.d["name"]} 기종 변경 셋업 {old} → {new} ({minutes:g}분)', station=self.code)
        self.set_phase(idx, 'setup')
        yield self.env.timeout(minutes * 60)
        # co_reason은 지우지 않는다: 셋업 직후 고장이 겹쳐 가공 시작 전에 상태를 다시 계산해도 사유가 남게
        what = self.co.get('what')
        detail = f'기종 변경 {old} → {new}' + (f' ({what})' if what else '')
        self.sim.change_point(self, 'METHOD', 'changeover', detail, self.fa_req)

    # ── 인터록 ──
    def ilk_send(self, load: Load) -> IlkReq:
        sim = self.sim
        rid = sim.next_rid('I')
        r = IlkReq(rid, load, self.env.event())
        sim.pending_ilk[rid] = r
        msg = {
            't': sim.now_iso(), 'reqId': rid, 'line': self.line, 'station': self.code, 'step': self.d['step'],
            'serial': load.main_serial(),
            # 처음 재공(MES가 모르는 시리얼)은 확인 대상에서 뺀다: 이력이 없어 공정 순서 판정을 할 수 없다
            'comps': [it.serial for it in load.comp_items() if not it.init],
            'lots': dict(load.lots),
        }
        if load.variant:
            msg['variant'] = load.variant
        if load.wo is not None:
            msg['wo'] = load.wo
        if load.fa:
            msg['fa'] = True
        if load.reinspect:
            msg['reinspect'] = True
        sim.publish(T.t_ilk_req(self.line, self.code), msg, qos=1)
        return r

    def ilk_settle(self, idx: int, loads: list[Load], reqs: dict[int, IlkReq]):
        """사이클이 끝난 뒤: 응답을 마저 기다려 통과·격리를 정한다. 통과한 묶음만 돌려준다"""
        sim, env = self.sim, self.env
        passed: list[Load] = []
        for ld in loads:
            r = reqs.get(id(ld))
            if r is None:
                passed.append(ld)
                continue
            deadline = env.now + (0.0 if sim.ilk_bypass else sim.virtual(sim.mes['ilkTimeoutSec']))
            while True:
                if r.verdict == 'OK':
                    passed.append(ld)
                    break
                if r.verdict == 'NG':
                    sim.quarantine(self, ld, r.code, r.reason)
                    break
                if r.verdict == 'WAIT':
                    self.set_phase(idx, 'ilk')
                    yield env.timeout(sim.virtual(sim.mes['ilkRetrySec']))
                    # 기다리는 사이 초물 대기가 생겼거나 MES가 초물을 기다리면 이 개체를 초물로 삼아 다시 묻는다
                    if not ld.fa and not self.fa_busy and (r.code == 'FA' or self.fa_change is not None):
                        ld.fa, ld.fa_id = True, self.fa_change or self.fa_last
                        self.fa_busy = True
                    r = self.ilk_send(ld)
                    deadline = env.now + sim.virtual(sim.mes['ilkTimeoutSec'])
                    continue
                left = deadline - env.now
                if left > 1e-9:
                    self.set_phase(idx, 'ilk')
                    yield env.timeout(left) | r.ev
                    continue
                # 시간 초과: 확인 없이 통과시킨다
                sim.pending_ilk.pop(r.rid, None)
                sim.ilk_timed_out()
                ld.skip = True
                passed.append(ld)
                break
        return passed

    # ── 가공 ──
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
                loads = [Load([Item(self.sim.new_serial('WIP'), src_item, self.line, init=True)], {})]
                cycle = self.sample_cycle() * (idx + 1) / self.slots
                start = env.now
            else:
                self.set_phase(idx, 'wait')
                loads = yield from self.take(idx)
                if not loads:
                    continue
                yield from self.prepare(idx, loads)
                yield from self.wait_ready()
                cycle = self.sample_cycle(loads[0].variant)
                start = env.now
            # 인터록: 투입 순간 묻고 사이클과 겹쳐 기다린다
            reqs: dict[int, IlkReq] = {}
            if self.ilk_on:
                for ld in loads:
                    if not ld.unknown_main():
                        reqs[id(ld)] = self.ilk_send(ld)
            if self.loader is not None and not pre:
                # 터널형: 입구에 한 개씩 피치 간격으로 들어간다
                with self.loader.request() as req:
                    yield req
                    yield env.timeout(cycle / self.slots)
            self.set_phase(idx, 'run')
            remaining = cycle - (env.now - start)
            while remaining > 1e-9:
                t0 = env.now
                pend = [r.ev for r in reqs.values() if not r.ev.triggered]
                try:
                    if pend:
                        yield env.timeout(remaining) | simpy.AnyOf(env, pend)
                        remaining -= env.now - t0
                        # 투입한 묶음이 모두 NG면 사이클을 즉시 멈춘다
                        if len(reqs) == len(loads) and all(r.verdict == 'NG' for r in reqs.values()):
                            break
                    else:
                        yield env.timeout(remaining)
                        remaining = 0.0
                except simpy.Interrupt:
                    remaining -= env.now - t0
                    self.set_phase(idx, 'hold')
                    yield from self.wait_ready()
                    self.set_phase(idx, 'run')
            took = env.now - start
            if reqs:
                loads = yield from self.ilk_settle(idx, loads, reqs)
                if not loads:
                    self.set_phase(idx, 'wait')
                    continue
            outs = self.finish(loads, start, took)
            self.set_phase(idx, 'block')
            for it in outs:
                yield self.out.put(it)
            self.set_phase(idx, 'wait')

    def make_item(self, load: Load) -> tuple[Item, list[Item]]:
        """이 공정의 결과 품목과 이번에 결합된 부품 목록"""
        if load.whole is not None:
            return load.whole, []
        items = load.items
        step = self.step
        if step['serial'] == 'new' or not items:
            serial = load.serial or self.sim.new_serial(step.get('prefix') or step['item'][:2])
            item = Item(serial, step['item'], self.line)
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
        if load.variant and (self.is_release or item.variant is None):
            item.variant, item.wo, item.wo_last = load.variant, load.wo, load.wo_last
        return item, merged

    def split_items(self, item: Item) -> list[Item]:
        """연배 분할: 투입 1개 → split개. 시리얼은 입력 시리얼 뒤에 -1, -2 … 를 붙인다"""
        n = self.split
        kids = []
        for k in range(1, n + 1):
            c = Item(f'{item.serial}-{k}', item.item, self.line)
            c.attrs = dict(item.attrs)
            c.variant, c.wo, c.wo_last = item.variant, item.wo, item.wo_last
            kids.append(c)
        # 잠재 불량은 연배 중 한 개에만 남는다
        for code in sorted(item.latent):
            kids[self.sim.xrng.randrange(n)].latent.add(code)
        return kids

    def judge(self, item: Item, cyc: dict[str, float], lots: dict[str, str], warm: dict | None):
        """한 개 판정: 부품 속성·불량·측정값·잠재 불량 검출·재가동 초품. (불량 코드, 공정 기록 값, 이 설비 속성)"""
        d = self.d
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
        # 5) 재가동 초품 (평소에는 난수를 쓰지 않아, 재가동이 없으면 결과가 전과 같다)
        if warm and ng is None and self.rng.random() < warm['prob']:
            ng = warm['defect']
        return ng, values, attrs_here

    def finish(self, loads: list[Load], start: float, cycle: float) -> list[Item]:
        cyc = self.sample_cycle_tags()
        self.values.update(cyc)
        # 재가동 직후 불안정 사이클 (한 사이클에 나오는 부품 모두에 적용)
        warm = self.d.get('warmup') if self.warm_left > 0 else None
        if warm:
            self.warm_left -= 1
        outs = []
        for load in loads:
            item, merged = self.make_item(load)
            if self.split > 1 and load.whole is None:
                parts, comps = self.split_items(item), [item.serial]
            else:
                parts, comps = [item], [m.serial for m in merged]
            for n, it in enumerate(parts):
                ng, values, attrs_here = self.judge(it, cyc, load.lots, warm)
                msg = {
                    't': self.sim.now_iso(), 'start': self.sim.iso_at(start), 'serial': it.serial, 'item': it.item,
                    'step': self.d['step'], 'station': self.code, 'line': self.line, 'result': 'NG' if ng else 'OK',
                    'values': values, 'cycle': round(cycle, 1),
                }
                if ng:
                    msg['defect'] = ng
                if attrs_here:
                    msg['attrs'] = attrs_here
                if comps:
                    msg['comps'] = comps
                if load.lots:
                    msg['lots'] = load.lots
                if self.final and not ng and it.latent:
                    msg['escaped'] = sorted(it.latent)
                if it.variant:
                    msg['variant'] = it.variant
                if it.wo is not None:
                    msg['wo'] = it.wo
                if load.fa and n == 0:
                    msg['fa'] = True
                if load.reinspect:
                    msg['reinspect'] = True
                if it.wo_last:
                    msg['woLast'] = True
                if load.skip:
                    msg['ilkSkip'] = True
                self.sim.stats.unit(self.code, ng)
                self.sim.publish(T.t_unit(self.line, self.code), msg, qos=1)
                it.init = False  # 이제 MES가 이 시리얼을 안다
                self.inspected(load, it, ng, values, first=(n == 0))
                if ng:
                    self.sim.on_ng(self, it, ng, load)
                else:
                    outs.append(it)
        return outs

    def inspected(self, load: Load, it: Item, ng: str | None, values: dict, first: bool) -> None:
        """초·중·종물: 초물이면 FIRST, woLast면 LAST, 중물 시각이 지났으면 MID"""
        rec = (it.serial, 'NG' if ng else 'OK', values, it.variant)
        now = self.env.now
        if load.fa and first:
            self.sim.inspect(self, 'FIRST', rec, change=load.fa_id)
            self.fa_busy = False
            if not ng and self.fa_change is not None and self.fa_change == load.fa_id:
                self.fa_change = None
            self.next_mid = now + self.mid_sec
        elif self.fa_req:
            if it.wo_last:
                self.sim.inspect(self, 'LAST', rec)
            elif now >= self.next_mid:
                self.sim.inspect(self, 'MID', rec)
                self.next_mid = now + self.mid_sec
        if self.fa_req:
            self.last_unit = rec

    def tags_payload(self) -> dict:
        v = {k: round_to(x, self.tagdef[k].get('digits')) for k, x in self.values.items()}
        msg = {'t': self.sim.now_iso(), 'v': v, 's': self.state}
        if self.state in ('DOWN', 'STOP') and self.reason:
            msg['r'] = self.reason
        return msg


def short_variant(code: str) -> str:
    """기종 코드의 짧은 이름 (HL-VX1-L → L)"""
    return code.rsplit('-', 1)[-1] if '-' in code else code


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


class Quarantined:
    """인터록에 걸려 격리 구역에 있는 투입 묶음"""

    __slots__ = ('st', 'load', 'code', 'keys')

    def __init__(self, st: Station, load: Load, code: str | None):
        self.st, self.load, self.code = st, load, code
        self.keys = load.serials()


class Sim:
    def __init__(self, factory: dict, io=None, speed: float = 5.0, realtime: bool = True, seed: int | None = None, tick: float = 1.0,
                 start: datetime | None = None):
        self.factory = factory
        self.io = io
        self.speed = float(speed)
        self.tick = tick
        self.realtime = realtime
        self.env = RealtimeEnvironment(factor=1.0 / self.speed, strict=False) if realtime else simpy.Environment()
        self.rng = random.Random(seed)
        # 실행 MES 쪽 난수 (수리·마모·상태 감시). 공정 난수와 따로 두어 기존 품질 흐름의 난수 순서를 덜 흔든다
        self.xrng = random.Random(None if seed is None else seed * 7919 + 17)
        self.start_dt = (start or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
        self.running = True
        self.stats = Stats()
        self.serial_seq: Counter = Counter()
        self.warehouse: Counter = Counter()
        self.escaped: Counter = Counter()
        self.mes = mes_table(factory)
        # 요청 번호 앞글자: 초기화 전 실행의 늦은 응답이 새 실행의 요청과 짝지어지지 않게 실행마다 다르게 한다
        self.run_tag = os.urandom(3).hex()
        self.rid_seq = 0
        self.change_seq = 0
        self.pending_ilk: dict[str, IlkReq] = {}
        self.ilk_miss = 0
        self.ilk_bypass = False
        self.pen: dict[str, tuple] = {}
        self.quar: dict[str, Quarantined] = {}

        self.steps = {(ln['code'], s['code']): s for ln in factory['lines'] for s in ln['steps']}
        self.buffers = {k: simpy.Store(self.env, capacity=s['buffer']) for k, s in self.steps.items()}
        self.inbound = {
            t['code']: simpy.Store(self.env, capacity=max(60, t['lot'] * 3))
            for t in factory['transfers'] if 'line' in t['to']
        }
        self.attrdefs = {a['key']: a for ln in factory['lines'] for st in ln['stations'] for a in st.get('attrs', ())}
        self.scen = Scenarios(self, factory['scenarios'])
        self.lots = Lots(self, factory['materials'])
        self.lines: dict[str, LineExec] = {ln['code']: LineExec(self, ln) for ln in factory['lines']}
        self.stations: dict[str, Station] = {}
        for ln in factory['lines']:
            for sd in ln['stations']:
                self.stations[sd['code']] = Station(self, ln, sd)
        amr_defs = {a['code']: a for a in factory['amrs']}
        self.amrs = [Amr(self, amr_defs[t['amr']], t) for t in factory['transfers']]
        self.health_st = [st for st in self.stations.values() if st.health]

        self.prefill()
        for st in self.stations.values():
            st.start()
        for a in self.amrs:
            self.env.process(a.run())
        self.telemetry_proc = self.env.process(self.telemetry())
        self.env.process(self.shift_loop())
        if self.io is not None and self.health_st:
            self.env.process(self.health_loop())

    def prefill(self) -> None:
        """공장은 늘 돌고 있던 상태로 시작한다: 부품 공정 버퍼(용량 10 이상)와 이송 도착 버퍼를 절반쯤 채운다.
        초기 재공은 이력이 없으므로 시리얼 앞글자를 WIP로 둔다."""
        finals = {(ln['code'], ln['finalStep']) for ln in self.factory['lines']}
        for key, store in self.buffers.items():
            step = self.steps[key]
            if key in finals or step['buffer'] < 10:
                continue
            for _ in range(step['buffer'] // 2):
                store.items.append(Item(self.new_serial('WIP'), step['item'], key[0], init=True))
        for code, store in self.inbound.items():
            tr = next(t for t in self.factory['transfers'] if t['code'] == code)
            src = self.steps[(tr['from']['line'], tr['from']['step'])]
            for _ in range(store.capacity * 2 // 3):
                store.items.append(Item(self.new_serial('WIP'), src['item'], tr['from']['line'], init=True))

    # ── 시각 ──
    def sim_dt(self, at: float | None = None) -> datetime:
        return self.start_dt + timedelta(seconds=self.env.now if at is None else at)

    def now_iso(self) -> str:
        return iso(self.sim_dt())

    def iso_at(self, at: float) -> str:
        return iso(self.sim_dt(at))

    def virtual(self, real_sec: float) -> float:
        """실제 초 → 가상 초 (응답 대기처럼 사람·서버 시간에 맞춰야 하는 간격)"""
        return float(real_sec) * self.speed

    def new_serial(self, prefix: str) -> str:
        self.serial_seq[prefix] += 1
        return f'{prefix}{self.sim_dt().astimezone(KST):%y%m%d}{self.serial_seq[prefix]:05d}'

    def next_rid(self, kind: str) -> str:
        self.rid_seq += 1
        return f'{self.run_tag}-{kind}{self.rid_seq}'

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
            'link': getattr(self.io, 'link', 'mqtt'),
            'scenarios': [
                {'id': sid, 'startedAt': self.iso_at(t0), 'level': round(self.scen.progress(sid), 3)}
                for sid, t0 in self.scen.active.items()
            ],
            'buffers': {f'{ln}.{st}': len(store.items) for (ln, st), store in self.buffers.items()},
            'inbound': {code: len(store.items) for code, store in self.inbound.items()},
            'warehouse': dict(self.warehouse),
            'escaped': dict(self.escaped),
            'lines': {code: lx.status() for code, lx in self.lines.items()},
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
            for st in self.health_st:
                st.health_tick(dt)
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

    # ── 실행 MES: 변경점·검사 ──
    def change_point(self, st: Station, category: str, kind: str, detail: str, fa: bool) -> str:
        """4M 변경점을 알린다. fa면 그 설비의 다음 개체가 초물이 된다 (대기 변경점이 여럿이면 마지막 id로 묶는다)"""
        self.change_seq += 1
        cid = f'S{self.change_seq}'
        self.publish(T.t_change(st.line, st.code), {
            't': self.now_iso(), 'id': cid, 'line': st.line, 'station': st.code,
            'category': category, 'kind': kind, 'detail': detail, 'fa': bool(fa),
        }, qos=1)
        st.fa_last = cid
        if fa:
            st.fa_change = cid
        return cid

    def inspect(self, st: Station, typ: str, rec: tuple, change: str | None = None) -> None:
        serial, result, values, variant = rec
        msg = {'t': self.now_iso(), 'line': st.line, 'station': st.code, 'type': typ, 'serial': serial, 'result': result, 'values': values}
        if change:
            msg['change'] = change
        if variant:
            msg['variant'] = variant
        self.publish(T.t_insp(st.line, st.code), msg, qos=1)

    def shift_loop(self):
        """가상 한국 시각 교대 시작(08·20시): 끝나는 교대의 종물(LAST) → 새 교대 MAN 변경점 (초물 대기)"""
        shifts = sorted(self.mes.get('shifts') or (), key=lambda s: s['startHour'])
        if not shifts:
            return
        while True:
            now = self.sim_dt().astimezone(KST)
            ahead = now + timedelta(seconds=0.5)
            nxt, name = None, ''
            for day in (0, 1):
                for s in shifts:
                    cand = (now + timedelta(days=day)).replace(hour=int(s['startHour']), minute=0, second=0, microsecond=0)
                    if cand > ahead and (nxt is None or cand < nxt):
                        nxt, name = cand, s['name']
            yield self.env.timeout((nxt - now).total_seconds())
            self.shift_change(name)

    def shift_change(self, name: str) -> None:
        for st in self.stations.values():
            if not st.fa_req:
                continue
            if st.last_unit:
                self.inspect(st, 'LAST', st.last_unit)
            self.change_point(st, 'MAN', 'shift', f'{name} 교대 시작', True)

    def health_loop(self):
        iv = float(self.mes.get('healthIntervalSec') or 60)
        while True:
            yield self.env.timeout(iv)
            for st in self.health_st:
                self.publish(T.t_health(st.line, st.code), st.health_payload())

    # ── 실행 MES: 응답 ──
    def on_reply(self, topic: str, msg: dict) -> None:
        """MES 응답 (인터록 lt/v1/{line}/{station}/ilk/res · 작업지시 lt/v1/{line}/wo/res)"""
        parts = topic.split('/')
        if len(parts) == 6 and parts[4] == 'ilk' and parts[5] == 'res':
            self.on_ilk_res(msg)
        elif len(parts) == 5 and parts[3] == 'wo' and parts[4] == 'res':
            lx = self.lines.get(parts[2])
            if lx is not None:
                lx.on_wo_res(msg)

    def on_ilk_res(self, msg: dict) -> None:
        if self.ilk_bypass and self.realtime:
            print('[sim] MES 인터록 응답이 다시 온다 · 확인 대기 재개', flush=True)
        self.ilk_miss = 0
        self.ilk_bypass = False
        r = self.pending_ilk.pop(str(msg.get('reqId')), None)
        if r is None:
            return
        v = msg.get('verdict')
        r.verdict = v if v in ('OK', 'NG', 'WAIT') else 'OK'
        r.code = msg.get('code')
        r.reason = msg.get('reason')
        if not r.ev.triggered:
            r.ev.succeed()

    def ilk_timed_out(self) -> None:
        self.ilk_miss += 1
        if not self.ilk_bypass and self.ilk_miss >= ILK_BYPASS_AFTER:
            self.ilk_bypass = True
            if self.realtime:
                print(f'[sim] MES 인터록 응답이 {ILK_BYPASS_AFTER}번 연달아 없음 · 응답이 올 때까지 확인 없이 통과(ilkSkip)', flush=True)

    # ── 실행 MES: 격리·불량 처리 ──
    def quarantine(self, st: Station, load: Load, code: str | None, reason: str | None) -> None:
        q = Quarantined(st, load, code)
        for k in q.keys:
            self.quar[k] = q
        self.lines[st.line].quar_n += 1
        if load.fa:
            st.fa_busy = False
            load.fa, load.fa_id = False, None

    def _unquarantine(self, serials: list[str]) -> list[Quarantined]:
        out: list[Quarantined] = []
        for s in serials:
            q = self.quar.get(str(s))
            if q is None or q in out:
                continue
            out.append(q)
            for k in q.keys:
                if self.quar.get(k) is q:
                    del self.quar[k]
            self.lines[q.st.line].quar_n -= 1
        return out

    def release_hold(self, serials: list[str]) -> int:
        """Hold 해제: 격리 구역의 묶음을 걸렸던 설비의 되돌림 줄로 보낸다 (다시 인터록을 묻는다)"""
        qs = self._unquarantine(serials)
        for q in qs:
            ld = q.load
            ld.back, ld.skip = True, False
            q.st.push_return(ld)
        return len(qs)

    def scrap_hold(self, serials: list[str]) -> int:
        qs = self._unquarantine(serials)
        for q in qs:
            self.lines[q.st.line].scrapped += 1
        return len(qs)

    def ng_rule(self, station: str, defect: str) -> dict:
        r = (self.mes.get('ngRule') or {}).get(station, {}).get(defect)
        if r:
            return r
        mi = self.mes['stations'].get(station) or {}
        dflt = self.mes.get('repairDefault') or {}
        action = 'REPAIR' if mi.get('inspection') and mi.get('productScope') else 'SCRAP'
        return {'action': action, 'rule': 'default', 'minutes': dflt.get('minutes', 10), 'prob': dflt.get('prob', 0.85)}

    def on_ng(self, st: Station, item: Item, defect: str, load: Load) -> None:
        """NG 개체: 제품 경로면 불량 대기에 두고 판정을 기다린다 (밖이면 지금처럼 버린다)"""
        if not st.scope:
            return
        self.pen[item.serial] = (st, item, defect)
        self.lines[st.line].pen_n += 1
        if self.io is None:
            # 오프라인: 기본 판정을 스스로 적용한다 (MRB·재검사 불합격은 폐기)
            action = self.ng_rule(st.code, defect).get('action', 'SCRAP')
            if load.reinspect or action == 'MRB':
                action = 'SCRAP'
            self.dispose(item.serial, action)

    def dispose(self, serial: str, decision: str) -> bool:
        if decision not in ('REPAIR', 'REWORK', 'SCRAP', 'UAI'):
            print(f'[sim] 알 수 없는 불량 처리 판정: {decision!r} ({serial})', flush=True)
            return False
        e = self.pen.pop(str(serial), None)
        if e is None:
            return False
        st, item, defect = e
        lx = self.lines[st.line]
        lx.pen_n -= 1
        if decision in ('REPAIR', 'REWORK'):
            self.env.process(lx.repair(st, item, defect, decision))
        elif decision == 'UAI':
            # 특채: 그 공정의 출력 버퍼로 그대로 넘긴다 (실적을 다시 내지 않는다)
            self.env.process(self._put(st.out, item))
        else:
            lx.scrapped += 1
        return True

    def _put(self, store, item: Item):
        yield store.put(item)

    def lot_hold(self, material: str, lot: str) -> bool:
        """자재 LOT Hold: 지금 그 LOT를 쓰고 있으면 바로 새 LOT로 바꾼다 (쓰는 설비마다 LOT 변경점이 생긴다)"""
        if material in self.lots.defs and self.lots.cur.get(material) == lot:
            self.lots.force_new(material, 'Hold')
            return True
        return False

    def wo_cancel(self, line: str, wo_id: int) -> None:
        lx = self.lines.get(line)
        if lx is not None:
            lx.cancel(int(wo_id))

    def user_change(self, cmd: dict) -> None:
        """작업자가 MES에 등록한 변경점: 그 id로 초물 대기를 건다 (ChangeMsg는 다시 보내지 않는다)"""
        st = self.stations.get(str(cmd.get('code')))
        cid = cmd.get('id')
        if st is None or not cid:
            return
        st.fa_last = str(cid)
        if cmd.get('fa'):
            st.fa_change = str(cid)

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
        elif op == 'pm':
            st.start_pm()

    def flush_stats(self) -> None:
        for st in self.stations.values():
            self.stats.state_change(st.code, st.state, self.env.now - st.since)
            st.since = self.env.now
