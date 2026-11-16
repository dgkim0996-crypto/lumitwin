"""What-if 계획 시뮬레이션 실행기 (P11).

서버가 지금 공장 상태(기준 상태)와 비교할 계획들을 표준 입력 JSON 한 덩어리로 넘기면,
계획마다 씨앗만 바꿔 여러 번 오프라인 최대 속도로 돌리고 반복별 원자료를 표준 출력에 줄마다 JSON으로 낸다.
형식은 shared/src/whatif.ts의 WhatIfSimInput · WhatIfSimLine · WhatIfRep.

실행: python -m lumisim.whatif < input.json
      python -m lumisim.whatif --example   (초기화한 공장·자동 계획으로 8시간 × 2회, 형식 확인용)

KPI(OEE·에너지)는 여기서 계산하지 않는다. 서버가 라이브 화면과 같은 함수로 계산해야 숫자의 기준이 같다.
"""
from __future__ import annotations

import bisect
import json
import math
import sys
import time
from collections import Counter, defaultdict, deque
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone

from .engine import Item, Load, Sim
from .model import load_factory

_FACTORY: dict | None = None


def _factory(path: str | None = None) -> dict:
    global _FACTORY
    if _FACTORY is None:
        _FACTORY = load_factory(path)
    return _FACTORY


def _init_worker(path: str | None) -> None:
    _factory(path)


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(timezone.utc)


class Tracker:
    """반복 1회의 집계: 작업지시별 투입·완성·폐기와 끝난 시각, 라인 양품 시각, 기종 변경·고장 횟수.

    작업지시가 끝난 시각 = 투입을 다 마쳤고 그 지시로 투입한 개체가 공장 안에 하나도 남지 않은 순간
    (마지막 개체가 최종 공정을 나왔거나 폐기됐을 때). 제품 경로에는 한 개가 여러 개로 나뉘는 공정이 없어서 개수가 맞는다.
    """

    def __init__(self, sim: Sim):
        self.sim = sim
        self.on = False  # 기준 상태를 적용하는 동안 생긴 사건(고장 중인 설비를 다시 세우는 것 등)은 세지 않는다
        self.orders: dict[tuple[str, int], dict] = {}
        self.final_times: dict[str, list[float]] = defaultdict(list)
        self.out: Counter = Counter()
        self.scrap_n: Counter = Counter()
        self.changeovers: Counter = Counter()
        self.failures: Counter = Counter()

    def register(self, line: str, o: dict, released: int = 0, done: int = 0) -> dict:
        key = (line, int(o['id']))
        rec = self.orders.get(key)
        if rec is None:
            rec = {
                'line': line, 'id': int(o['id']), 'code': str(o.get('code') or o['id']), 'variant': o.get('variant'),
                'qty': int(o.get('qty') or 0), 'released': int(released), 'done': int(done), 'scrap': 0,
                'in_sys': 0, 'finishedSec': None,
            }
            self.orders[key] = rec
        return rec

    def wip(self, line: str, wid: int) -> None:
        """기준 상태의 재공 한 개를 지금 투입 중인 지시 몫으로 친다"""
        rec = self.orders.get((line, wid))
        if rec is not None:
            rec['in_sys'] += 1

    def _check(self, rec: dict) -> None:
        if rec['finishedSec'] is None and rec['released'] >= rec['qty'] and rec['in_sys'] <= 0:
            rec['finishedSec'] = round(self.sim.env.now, 1)

    # ── 엔진이 부르는 곳 (engine.py의 sim.track) ──
    def assign(self, line: str, wo: dict, released: int, prev_variant: str | None) -> None:
        rec = self.register(line, wo, released=released)
        if self.on and prev_variant and wo.get('variant') and wo['variant'] != prev_variant:
            self.changeovers[line] += 1
        self._check(rec)

    def release(self, line: str, wid: int) -> None:
        rec = self.orders.get((line, wid))
        if rec is not None:
            rec['released'] += 1
            rec['in_sys'] += 1

    def final(self, line: str, item: Item, ng: str | None) -> None:
        if ng:
            return  # 최종 공정 불량은 불량 처리로 간다 (수리 뒤 돌아오거나 폐기된다)
        self.out[line] += 1
        self.final_times[line].append(self.sim.env.now)
        rec = self.orders.get((line, item.wo)) if item.wo is not None else None
        if rec is not None:
            rec['done'] += 1
            rec['in_sys'] -= 1
            self._check(rec)

    def scrap(self, line: str, wid: int | None) -> None:
        self.scrap_n[line] += 1
        rec = self.orders.get((line, wid)) if wid is not None else None
        if rec is not None:
            rec['scrap'] += 1
            rec['in_sys'] -= 1
            self._check(rec)

    def event(self, kind: str, station: str | None) -> None:
        if self.on and kind == 'failure' and station:
            self.failures[station] += 1


def _down_for(sim: Sim, st, minutes: float, reason: str) -> None:
    """설비를 세우고 minutes 뒤 수리한다 (그 사이 다른 수리가 먼저 끝냈으면 그대로 둔다)"""
    if not st.down:
        st.fail(reason)
    token = st.down_token

    def repair():
        yield sim.env.timeout(max(0.0, minutes) * 60)
        if st.down and st.down_token == token:
            st.repair()

    sim.env.process(repair())


def _fire(sim: Sim, ev: dict):
    yield sim.env.timeout(max(0.0, float(ev.get('atMin') or 0)) * 60)
    kind = ev.get('kind')
    if kind == 'scenario':
        sim.scenario(str(ev.get('id')), bool(ev.get('on')))
        return
    st = sim.stations.get(str(ev.get('station')))
    if st is None:
        return
    if kind == 'down':
        _down_for(sim, st, float(ev.get('minutes') or 0), 'What-if 고장')
    elif kind == 'pm':
        st.start_pm()


def apply_base(sim: Sim, tr: Tracker, base: dict, scen: dict) -> None:
    """기준 상태와 계획을 막 만든 Sim에 입힌다 (env.run 전에 부른다)"""
    base_lines = base.get('lines') or {}
    finals = {(ln['code'], ln['finalStep']) for ln in sim.factory['lines']}
    prod_steps = {(st.line, st.d['step']) for st in sim.stations.values() if st.scope}

    # 작업지시 계획 큐와 라인 기종
    running: dict[str, dict] = {}
    for line, lx in sim.lines.items():
        bl = base_lines.get(line) or {}
        done_by_id = {int(o['id']): int(o.get('done') or 0) for o in bl.get('orders') or ()}
        orders = [dict(o) for o in (scen.get('orders') or {}).get(line) or ()]
        lx.plan = deque(orders)
        lx.auto_fill = bool(scen.get('autoFill', True))
        v = bl.get('variant')
        if v:
            lx.variant = v
            for st in sim.stations.values():
                if st.line == line:
                    st.cur_variant = v
        for i, o in enumerate(orders):
            rel = int(o.get('released') or 0) if i == 0 else 0
            tr.register(line, o, released=rel, done=done_by_id.get(int(o['id']), 0))
            if i == 0 and rel > 0:
                running[line] = o

    def refill(stores: dict, counts: dict | None, key_of, tag: bool) -> None:
        if counts is None:
            return
        for key, store in stores.items():
            n = counts.get(key_of(key))
            if n is None:
                continue
            store.items.clear()
            if isinstance(key, tuple):
                line, item = key[0], sim.steps[key]['item']
            else:
                tr_def = next(t for t in sim.factory['transfers'] if t['code'] == key)
                line = tr_def['from']['line']
                item = sim.steps[(line, tr_def['from']['step'])]['item']
            run_o = running.get(line) if tag and key in prod_steps and key not in finals else None
            for _ in range(max(0, min(int(n), store.capacity))):
                it = Item(sim.new_serial('WIP'), item, line, init=True)
                if run_o is not None:
                    # 제품 경로 재공은 지금 투입 중인 지시 몫으로 본다 (어림: 앞 지시의 마지막 몇 개가 섞여 있을 수 있다)
                    it.variant, it.wo = run_o.get('variant'), int(run_o['id'])
                    tr.wip(line, int(run_o['id']))
                store.items.append(it)

    refill(sim.buffers, base.get('buffers'), lambda k: f'{k[0]}.{k[1]}', tag=True)
    refill(sim.inbound, base.get('inbound'), lambda k: k, tag=False)

    # 설비 안 개체 (가공·셋업·배출 대기 중, 하드코팅·증착 같은 슬롯·배치 설비 포함): 같은 점유와 남은 가공 시간으로 시작한다.
    # 없으면 엔진 기본(터널형은 가득 찬 채, 나머지는 빈 채)으로 둔다
    inproc = base.get('inproc')
    if inproc is not None:
        for code, slots in inproc.items():
            st = sim.stations.get(code)
            if st is None or st.utility:
                continue
            item = st.input_item()
            run_o = running.get(st.line) if st.scope else None
            pre: dict[int, tuple[list[Load], float]] = {}
            for i, (n, left) in enumerate(list(slots)[: st.slots]):
                loads = []
                for _ in range(max(1, min(int(n), st.batch))):
                    it = Item(sim.new_serial('WIP'), item, st.line, init=True)
                    if run_o is not None:
                        it.variant, it.wo = run_o.get('variant'), int(run_o['id'])
                        tr.wip(st.line, int(run_o['id']))
                    loads.append(Load([it], {}))
                pre[i] = (loads, max(0.0, float(left)))
            st.preload = pre

    # 설비: 마모, 고장 중, 보전 중
    for code, s in (base.get('stations') or {}).items():
        st = sim.stations.get(code)
        if st is None:
            continue
        if s.get('wear') is not None and st.health:
            st.wear = max(0.0, min(1.0, float(s['wear'])))
            st.temp = float(st.health['temp']) + 18 * st.wear
        state = s.get('state')
        if state == 'DOWN':
            st.fail('기준 시각에 고장 중')
            # 남은 수리 시간은 모른다: 평균 수리 시간 분포에서 새로 뽑는다 (assumed)
            sim.env.process(st._repair_after(st.down_token, st.xrng))
        elif state == 'PM':
            st.start_pm()

    # 공정 이상: 이미 elapsedMin만큼 진행된 것으로
    for s in base.get('scenarios') or ():
        sid = str(s.get('id'))
        if sim.scen.start(sid):
            sim.scen.active[sid] = -float(s.get('elapsedMin') or 0) * 60

    # 투입 시작 전에 이미 다 투입했고 재공도 없는 지시는 바로 끝난 것으로
    for rec in tr.orders.values():
        tr._check(rec)

    for ev in scen.get('events') or ():
        sim.env.process(_fire(sim, ev))


def run_rep(inp: dict, si: int, rep: int) -> dict:
    factory = _factory(inp.get('factory'))
    base = inp['base']
    scen = inp['scenarios'][si]
    seed = int(inp['seed']) + rep
    horizon = float(inp['horizonSec'])
    t0 = time.perf_counter()
    sim = Sim(factory, io=None, realtime=False, seed=seed, tick=5.0, start=_parse_dt(base.get('startAt')), streams=True)
    tr = Tracker(sim)
    sim.track = tr
    apply_base(sim, tr, base, scen)
    tr.on = True
    sim.env.run(until=horizon)
    sim.flush_stats()

    hours = max(1, math.ceil(horizon / 3600 - 1e-9))
    stations = {}
    for code, st in sim.stations.items():
        d = {
            'ok': sim.stats.ok[code],
            'ng': sim.stats.ng[code],
            'sec': {k: round(v, 1) for k, v in sim.stats.state_sec[code].items() if v > 0},
            'failures': tr.failures[code],
        }
        if st.health:
            d['wearEnd'] = round(st.wear, 3)
        stations[code] = d
    lines = {}
    for code, lx in sim.lines.items():
        ts = sorted(tr.final_times[code])
        lines[code] = {
            'out': tr.out[code],
            'scrap': tr.scrap_n[code],
            'repaired': lx.repaired,
            'changeovers': tr.changeovers[code],
            'hourly': [bisect.bisect_right(ts, min(h * 3600.0, horizon)) for h in range(1, hours + 1)],
        }
    orders = [
        {k: rec[k] for k in ('line', 'id', 'code', 'variant', 'qty', 'released', 'done', 'scrap', 'finishedSec')}
        for rec in tr.orders.values()
    ]
    return {
        'scenario': si, 'rep': rep, 'seed': seed, 'wallMs': round((time.perf_counter() - t0) * 1000),
        'stations': stations, 'lines': lines, 'orders': orders,
    }


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def run_all(inp: dict, progress=emit) -> list[dict]:
    jobs = [(si, r) for si in range(len(inp['scenarios'])) for r in range(int(inp['reps']))]
    total = len(jobs)
    progress({'type': 'progress', 'done': 0, 'total': total})
    workers = max(1, min(int(inp.get('workers') or 1), total))
    runs: list[dict] = []
    if workers == 1:
        for si, r in jobs:
            runs.append(run_rep(inp, si, r))
            progress({'type': 'progress', 'done': len(runs), 'total': total})
    else:
        with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker, initargs=(inp.get('factory'),)) as ex:
            futs = [ex.submit(run_rep, inp, si, r) for si, r in jobs]
            for f in as_completed(futs):
                runs.append(f.result())
                progress({'type': 'progress', 'done': len(runs), 'total': total})
    runs.sort(key=lambda x: (x['scenario'], x['rep']))
    return runs


def example_input() -> dict:
    """형식 확인용: 초기화한 공장, 계획 없음(자동 계획), 둘째 계획은 1시간 뒤 헤드램프 렌즈 사출기 2시간 고장"""
    factory = _factory()
    lines = {ln['code']: {'variant': None, 'orders': []} for ln in factory['lines']}
    empty = {ln['code']: [] for ln in factory['lines']}
    return {
        'horizonSec': 8 * 3600, 'reps': 2, 'seed': 101, 'workers': 2,
        'base': {'source': 'clean', 'startAt': '2026-11-16T00:00:00.000Z', 'lines': lines, 'notes': []},
        'scenarios': [
            {'orders': empty, 'events': [], 'autoFill': True},
            {'orders': empty, 'events': [{'kind': 'down', 'station': 'HL-IM-L1', 'atMin': 60, 'minutes': 120}], 'autoFill': True},
        ],
    }


def main() -> None:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except AttributeError:
            pass
    try:
        if '--example' in sys.argv:
            inp = example_input()
        else:
            inp = json.loads(sys.stdin.buffer.read().decode('utf-8'))
        emit({'type': 'result', 'runs': run_all(inp)})
    except SystemExit as e:
        emit({'type': 'error', 'message': str(e)})
        raise
    except Exception as e:  # 서버가 실패 사유를 화면에 보여 준다
        emit({'type': 'error', 'message': f'{type(e).__name__}: {e}'})
        sys.exit(1)


if __name__ == '__main__':
    main()
