"""실행:
  python -m lumisim                         MQTT(127.0.0.1:1884)로 실시간 실행 (기본 5배속)
  python -m lumisim --speed 20              배속 지정
  python -m lumisim --offline --hours 8     브로커 없이 최대 속도로 8시간(가상) 돌리고 공정별 통계를 출력 (보정용)
  python -m lumisim --offline --hours 6 --scenario HL-MOLD-COOL --at 1
"""
from __future__ import annotations

import argparse
import faulthandler
import os
import sys
import time

from .engine import Sim, resync_clock
from .model import load_factory


def handle(sim: Sim, cmd: dict, factory: dict, io) -> Sim:
    action = cmd.get('action')
    if action == 'speed':
        sim.set_speed(cmd.get('speed', sim.speed))
    elif action == 'pause':
        sim.set_running(False)
    elif action == 'resume':
        sim.set_running(True)
    elif action == 'reset':
        speed = sim.speed
        sim = Sim(factory, io, speed=speed)
        sim.event('reset', '시뮬레이션 초기화')
        print('[sim] 초기화', flush=True)
    elif action == 'scenario':
        sim.scenario(str(cmd.get('id')), bool(cmd.get('on')))
    elif action == 'station':
        reason = cmd.get('reason')
        sim.station_op(str(cmd.get('code')), str(cmd.get('op')), str(reason)[:40] if reason else None)
    return sim


# 실제 시간보다 이만큼 넘게 밀리면(절전 복귀, 디버거 정지 등) 따라잡지 않고 시계를 다시 맞춘다.
# 따라잡으면 몇 시간치 가상 시간을 몇 초에 몰아 돌려 MQTT 메시지가 쏟아지고 MES가 대부분 놓친다
MAX_LAG_SEC = 5.0


def resync_if_behind(sim) -> None:
    env = sim.env
    lag = time.monotonic() - (env.real_start + (env.now - env.env_start) * env.factor)
    if lag > MAX_LAG_SEC:
        resync_clock(env)
        print(f'[sim] 실제 시간보다 {lag:.0f}초 밀려 가상 시계를 다시 맞춤 (밀린 구간은 건너뜀)', flush=True)


def run_live(args) -> None:
    from .mqtt_io import MqttIO

    factory = load_factory(args.factory)
    io = MqttIO(args.host, args.port)
    sim = Sim(factory, io, speed=args.speed, seed=args.seed)
    n = sum(len(ln['stations']) for ln in factory['lines'])
    print(f'[sim] 가상 공장 시작 · 라인 {len(factory["lines"])} · 설비 {n} · AMR {len(sim.amrs)} · {sim.speed:g}배속', flush=True)
    # 멈춤 감시: 메인 루프가 STALL_SEC 넘게 돌지 않으면 모든 스레드의 스택을 stderr에 남긴다.
    # faulthandler의 감시 스레드는 GIL 없이 돌아서, 메인 스레드가 C 호출(대기·쓰기)에 막혀 있어도 찍힌다.
    stall_sec = float(os.environ.get('SIM_STALL_SEC', '30'))
    beat = 0.0
    paused_beat = 0.0
    try:
        while True:
            now = time.monotonic()
            if stall_sec > 0 and now - beat >= 1.0:
                faulthandler.dump_traceback_later(stall_sec, repeat=True, file=sys.stderr)
                beat = now
            while not io.cmds.empty():
                sim = handle(sim, io.cmds.get_nowait(), factory, io)
            if not sim.running:
                if now - paused_beat >= 1.0:
                    sim.publish_status()
                    paused_beat = now
                time.sleep(0.05)
                continue
            resync_if_behind(sim)
            sim.env.run(until=sim.env.now + sim.speed * 0.1)
    except KeyboardInterrupt:
        pass
    finally:
        faulthandler.cancel_dump_traceback_later()
        io.close()


def pct(a: float, b: float) -> str:
    return f'{(100.0 * a / b):5.1f}%' if b else '   - '


def run_offline(args) -> None:
    factory = load_factory(args.factory)
    sim = Sim(factory, io=None, realtime=False, seed=args.seed, tick=5.0)
    horizon = args.hours * 3600
    if args.scenario:
        at = args.at * 3600

        def starter():
            yield sim.env.timeout(at)
            for sid in args.scenario.split(','):
                sim.scenario(sid, True)

        sim.env.process(starter())
    t0 = time.time()
    sim.env.run(until=horizon)
    sim.flush_stats()
    st = sim.stats
    print(f'가상 {args.hours}시간 · 계산 {time.time() - t0:.1f}s · 시나리오 {args.scenario or "-"}')
    print(f'{"설비":<12}{"OK":>7}{"NG":>6}{"NG%":>8}  {"RUN":>6}{"IDLE":>7}{"BLOCK":>7}{"DOWN":>7}  주요 불량')
    for ln in factory['lines']:
        print(f'── {ln["name"]}')
        for sd in ln['stations']:
            code = sd['code']
            ok, ng = st.ok[code], st.ng[code]
            secs = st.state_sec[code]
            total = sum(secs.values()) or 1
            top = ', '.join(f'{k}:{v}' for k, v in st.defects[code].most_common(3))
            print(f'{code:<12}{ok:>7}{ng:>6}{pct(ng, ok + ng):>8}  {pct(secs["RUN"], total):>6}{pct(secs["IDLE"], total):>7}{pct(secs["BLOCKED"], total):>7}{pct(secs["DOWN"], total):>7}  {top}')
    print('창고 입고:', dict(sim.warehouse))
    print('출하 유출(잠재 불량):', dict(sim.escaped))
    for ln in factory['lines']:
        final = [s for s in ln['stations'] if s['step'] == ln['finalStep']]
        out = sum(st.ok[s['code']] for s in final)
        print(f'{ln["short"]} 완성 {out}개 · 시간당 {out / args.hours:.1f}개 (목표 택트 {ln["taktSec"]}s → {3600 / ln["taktSec"]:.0f}개/h)')


def main() -> None:
    ap = argparse.ArgumentParser(prog='lumisim', description='LumiTwin 가상 공장 시뮬레이터')
    ap.add_argument('--host', default=os.environ.get('MQTT_HOST', '127.0.0.1'))
    ap.add_argument('--port', type=int, default=int(os.environ.get('MQTT_PORT', '1884')))
    ap.add_argument('--speed', type=float, default=float(os.environ.get('SIM_SPEED', '5')))
    ap.add_argument('--factory', default=None, help='factory.json 경로 (기본: shared/dist/factory.json)')
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--offline', action='store_true', help='브로커 없이 최대 속도로 돌려 통계 출력')
    ap.add_argument('--hours', type=float, default=8.0)
    ap.add_argument('--scenario', default=None, help='오프라인: 켤 시나리오 ID (쉼표로 여러 개)')
    ap.add_argument('--at', type=float, default=1.0, help='오프라인: 시나리오 시작 시각 (가상 시간, 시)')
    args = ap.parse_args()
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except AttributeError:
            pass
    if args.offline:
        run_offline(args)
    else:
        run_live(args)


if __name__ == '__main__':
    main()
