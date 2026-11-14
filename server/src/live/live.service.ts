import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import {
  DEFECT_NAMES,
  LINES,
  SPC_RULES,
  STARTUP_WINDOW_SEC,
  STATIONS,
  type AlarmLive,
  type AmrMsg,
  type EdgeStatusMsg,
  type LineDef,
  type LineLive,
  type LiveSnapshot,
  type LossReport,
  type Oee,
  type SimEventMsg,
  type SimStatusMsg,
  type SpcChart,
  type StateMsg,
  type StationDef,
  type StationLive,
  type StationLoss,
  type StationState,
  type TagsMsg,
  type TickPayload,
  type UnitMsg,
  SPC_SUBGROUP,
} from '@lumitwin/shared';
import { MqttBrokerService, type MqttInbound } from '../mqtt/mqtt-broker.service';
import { roundLosses, stationLosses, sumLosses } from './losses';
import { r3, stationOee, type StateTimes } from './oee';
import { aheadLimitMs, outOfRun } from './run-clock';
import { buildSeries, SPC_KEEP_POINTS, type SpcSeries } from './spc';

type Station = StationDef & { line: LineDef['code'] };

interface StationRt {
  def: Station;
  live: StationLive;
  /** 현재 상태가 시작된 가상 시각 (ms). 첫 메시지를 받기 전에는 NaN */
  sinceMs: number;
  /** 한 개당 이상 사이클 (초) = 사이클 ÷ (동시 투입 수 × 배치 수) */
  idealSec: number;
  utility: boolean;
  /** 최근 판정 (true = NG) */
  window: boolean[];
  qualityOn: boolean;
  /** 연속 태그 규격 이탈: 연속 횟수와 알람 상태 */
  limitRun: Map<string, number>;
  limitOn: Set<string>;
  /** 마지막으로 DOWN에서 벗어난 가상 시각 (ms). 복구 직후 값이 돌아오는 동안은 규격 경보를 보류한다 */
  upAtMs: number;
  spc: Map<string, SpcSeries>;
  /** 직전 가공의 시작 시각 ms (배치 판별) */
  lastStartMs: number;
  /** 마지막으로 고장·셋업·정지에서 다시 돌기 시작한 가상 시각 (ms). 초기 수율 로스 판정 */
  restartMs: number;
  /** 재가동 직후(STARTUP_WINDOW_SEC 안) 나온 불량 수 */
  startupNg: number;
}

interface LineRt {
  def: LineDef;
  startMs: number;
  output: number;
  ng: number;
  finals: number[];
  steps: Map<string, { ok: number; ng: number }>;
}

/** 알람 판단 기준 */
const QUALITY_WINDOW = 40;
const QUALITY_MIN_NG = 4;
const QUALITY_ON = 0.1;
const QUALITY_OFF = 0.05;
const LIMIT_TICKS = 3;
const LIMIT_HOLD_MS = 10 * 60_000;
const MAX_ALARMS = 300;
const SIM_TIMEOUT_MS = 5_000;
/** 엣지 게이트웨이는 2초마다 상태를 낸다. 세 번 못 받으면 끊긴 것으로 본다 */
const EDGE_TIMEOUT_MS = 6_500;
/** 실행을 확인하기 전(첫 상태 메시지 전)에 붙잡아 둘 최대 메시지 수 */
const MAX_HELD = 20_000;
/** 멈춘 상태: 여기서 벗어나면 재가동으로 본다 */
const HALTED = new Set<StationState>(['DOWN', 'SETUP', 'STOP']);

export interface LiveEvents {
  run: [startedAt: string];
  unit: [msg: UnitMsg];
  state: [station: string, state: StationState, reason: string | undefined, t: string];
  alarm: [alarm: AlarmLive];
  /** 알람 확인. alarmAt은 알람이 난 시각 (DB에서 같은 알람을 정확히 찾는 데 쓴다) */
  ack: [id: number, at: string, alarmAt: string];
  event: [msg: SimEventMsg];
}

/** 복원용 설비 기록 하나 (오래된 것부터) */
export interface RestoreRecord {
  serial: string;
  result: UnitMsg['result'];
  defect: string | null;
  values: Record<string, number>;
  cycle: number;
  start: Date;
  end: Date;
}

/**
 * DB 기록으로 다시 계산한 실행 상태. 서버를 다시 띄워도 실시간 집계를 0부터 세지 않고 이어 가려고 쓴다.
 * 메모리 집계와 DB 기록은 같은 이벤트에서 나오므로, DB를 다시 모으면 메모리 상태를 되살릴 수 있다.
 */
export interface LiveHydration {
  startedAt: string;
  /** 기록에 남은 가장 늦은 가상 시각 */
  nowMs: number;
  /** 설비·공정·판정·불량별 처리 수와 첫 투입 시각 */
  counts: { station: string; step: string; result: string; defect: string | null; n: number; firstStart: Date }[];
  /** 설비별 최근 기록. SPC 관리도와 최근 불량률 창을 다시 채운다 */
  recent: Map<string, RestoreRecord[]>;
  /** 최근 1시간 최종 공정 양품 완료 (시각 오름차순) */
  finals: { station: string; step: string; at: Date }[];
  /** 설비·상태별 닫힌 구간 합(초)과 현재 상태 */
  states: { station: string; state: string; sec: number; openAt: Date | null; openReason: string | null; upAt: Date | null; firstAt: Date }[];
  /** 최근 알람 (새것부터) */
  alarms: AlarmLive[];
  alarmSeq: number;
  /** 이 실행에서 한 번이라도 난 규격 이탈 알람 */
  limitAlarms: { station: string; title: string }[];
}

const limitTitle = (rt: StationRt, tagName: string) => `${rt.def.name} · ${tagName} 규격 이탈`;

/**
 * MES 실시간 계층. MQTT로 들어온 값을 메모리에 모아 설비 상태·OEE·FPY·SPC·알람을 계산한다.
 * DB 기록은 ProductionService가 이 서비스의 이벤트를 받아 모아서 쓴다 (수집 경로가 DB에 막히지 않게).
 */
@Injectable()
export class LiveService implements OnModuleInit {
  private readonly logger = new Logger('Live');
  readonly events = new EventEmitter<LiveEvents>();

  private runStartedAt: string | null = null;
  private nowMs = 0;
  private sim: SimStatusMsg | null = null;
  private lastSimAt = 0;
  private edge: EdgeStatusMsg | null = null;
  private lastEdgeAt = 0;
  private stations = new Map<string, StationRt>();
  private lines = new Map<string, LineRt>();
  private amrs: Record<string, AmrMsg> = {};
  private alarms: AlarmLive[] = [];
  private alarmSeq = 0;
  /**
   * 시뮬레이터 상태 메시지로 실행을 확인하기 전에 온 메시지. 확인한 뒤 순서대로 처리한다.
   * 어느 실행의 값인지 모른 채 세면 메모리 집계와 DB 기록이 어긋난다 (DB 쪽은 실행을 모르면 버린다)
   */
  private held: MqttInbound[] | null = [];
  /** 이번 실행에서 다른 실행의 시각이라 버린 설비 메시지 수 (처음 한 번만 로그를 남긴다) */
  private staleDropped = 0;

  constructor(private readonly mqtt: MqttBrokerService) {
    this.reset();
  }

  onModuleInit(): void {
    this.mqtt.onMessage((m) => this.receive(m));
  }

  // ───────────── 수집 ─────────────

  private receive(m: MqttInbound): void {
    // 엣지 게이트웨이 상태는 시뮬레이터 실행과 무관하다 (실제 시각, 실행이 바뀌어도 이어진다)
    if (m.parts[0] === 'edge') {
      if (m.parts[1] === 'status') {
        this.edge = m.payload as EdgeStatusMsg;
        this.lastEdgeAt = Date.now();
      }
      return;
    }
    if (!this.held) return this.ingest(m);
    if (m.parts[0] !== 'sim' || m.parts[1] !== 'status') {
      if (this.held.length < MAX_HELD) this.held.push(m);
      return;
    }
    const held = this.held;
    this.held = null;
    this.ingest(m);
    for (const x of held) this.receive(x);
  }

  private ingest({ parts, payload }: MqttInbound): void {
    if (parts[0] === 'sim') {
      if (parts[1] === 'status') this.onStatus(payload as SimStatusMsg);
      else if (parts[1] === 'event') this.onEvent(payload as SimEventMsg);
      return;
    }
    // 설비·AMR 메시지는 시뮬레이터 상태가 알려 준 실행 구간 안의 시각만 받는다 (run-clock.ts)
    const t = (payload as { t?: string } | null)?.t;
    if (outOfRun(Date.parse(t ?? ''), this.sim)) {
      if (this.staleDropped++ === 0) {
        this.logger.warn(`지금 실행의 시각이 아닌 설비 메시지를 버렸습니다: ${parts.join('/')} ${t} (실행 ${this.sim?.startedAt} · 시뮬레이터 시각 ${this.sim?.t})`);
      }
      return;
    }
    if (parts[0] === 'amr') {
      const msg = payload as AmrMsg;
      this.amrs[parts[1]] = msg;
      this.advance(msg.t);
      return;
    }
    const [, code, kind] = parts;
    const rt = this.stations.get(code);
    if (!rt) return;
    if (kind === 'tags') this.onTags(rt, payload as TagsMsg);
    else if (kind === 'state') this.onState(rt, payload as StateMsg);
    else if (kind === 'unit') this.onUnit(rt, payload as UnitMsg);
  }

  private advance(t: string): number {
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > this.nowMs) this.nowMs = ms;
    return Number.isFinite(ms) ? ms : this.nowMs;
  }

  private onStatus(msg: SimStatusMsg): void {
    if (this.runStartedAt && this.runStartedAt !== msg.startedAt) {
      this.logger.log('시뮬레이터 실행이 바뀌어 실시간 집계를 새로 시작합니다');
      this.reset();
    }
    if (this.runStartedAt !== msg.startedAt) {
      this.runStartedAt = msg.startedAt;
      this.events.emit('run', msg.startedAt);
    }
    this.sim = msg;
    this.lastSimAt = Date.now();
    // 시계는 시뮬레이터 상태가 기준이다. 한참 앞서 있으면(이전 실행의 늦은 메시지가 섞였던 기록으로 되살린 경우 등) 되돌린다
    const simMs = Date.parse(msg.t);
    if (Number.isFinite(simMs) && this.nowMs > simMs + aheadLimitMs(msg.speed)) this.nowMs = simMs;
    this.advance(msg.t);
  }

  private onEvent(msg: SimEventMsg): void {
    if (msg.kind === 'reset') {
      this.reset();
      this.runStartedAt = null;
      this.held = [];
    }
    this.advance(msg.t);
    this.events.emit('event', msg);
  }

  private onTags(rt: StationRt, msg: TagsMsg): void {
    const t = this.advance(msg.t);
    if (Number.isNaN(rt.sinceMs)) rt.sinceMs = t;
    rt.live.tags = msg.v;
    if (msg.s && msg.s !== rt.live.state) this.applyState(rt, msg.s, msg.r, msg.t);
    this.checkLimits(rt, msg.v, t);
  }

  private onState(rt: StationRt, msg: StateMsg): void {
    this.advance(msg.t);
    this.applyState(rt, msg.state, msg.reason, msg.t);
  }

  private applyState(rt: StationRt, state: StationState, reason: string | undefined, t: string): void {
    const ms = Date.parse(t);
    const live = rt.live;
    if (Number.isNaN(rt.sinceMs)) rt.sinceMs = ms;
    if (state === live.state) {
      live.reason = reason;
      return;
    }
    const prev = live.state;
    live.stateSec[prev] = (live.stateSec[prev] ?? 0) + Math.max(0, ms - rt.sinceMs) / 1000;
    if (prev === 'DOWN') rt.upAtMs = ms;
    if (HALTED.has(prev) && !HALTED.has(state)) rt.restartMs = ms;
    live.state = state;
    live.reason = reason;
    live.since = t;
    rt.sinceMs = ms;
    this.events.emit('state', rt.def.code, state, reason, t);
    if (state === 'DOWN') {
      this.raise(rt.def.code, 'critical', 'DOWN', `${rt.def.name} 고장 정지`, reason ? `사유: ${reason}` : undefined, t);
    }
  }

  private checkLimits(rt: StationRt, v: Record<string, number>, ms: number): void {
    const s = rt.live.state;
    const running = s === 'RUN' || s === 'IDLE' || s === 'BLOCKED';
    const settled = ms - rt.upAtMs > LIMIT_HOLD_MS && ms - Date.parse(this.sim?.startedAt ?? '') > LIMIT_HOLD_MS;
    for (const td of rt.def.tags) {
      if (td.mode !== 'continuous' || (td.lsl == null && td.usl == null)) continue;
      const x = v[td.key];
      if (x == null) continue;
      const out = (td.lsl != null && x < td.lsl) || (td.usl != null && x > td.usl);
      const run = out ? Math.max(0, rt.limitRun.get(td.key) ?? 0) + 1 : Math.min(0, rt.limitRun.get(td.key) ?? 0) - 1;
      rt.limitRun.set(td.key, run);
      if (out && running && settled && run >= LIMIT_TICKS && !rt.limitOn.has(td.key)) {
        rt.limitOn.add(td.key);
        const spec = `${td.lsl ?? '−'} ~ ${td.usl ?? '−'} ${td.unit}`;
        this.raise(rt.def.code, 'warn', 'LIMIT', limitTitle(rt, td.name), `현재 ${x} ${td.unit} (규격 ${spec})`, new Date(ms).toISOString());
      } else if (!out && run <= -LIMIT_TICKS) {
        rt.limitOn.delete(td.key);
      }
    }
  }

  private onUnit(rt: StationRt, msg: UnitMsg): void {
    this.advance(msg.t);
    const live = rt.live;
    const ng = msg.result === 'NG';
    if (ng) {
      live.ng++;
      if (msg.defect) live.defects[msg.defect] = (live.defects[msg.defect] ?? 0) + 1;
      const sinceRestart = Date.parse(msg.t) - rt.restartMs;
      if (sinceRestart >= 0 && sinceRestart <= STARTUP_WINDOW_SEC * 1000) rt.startupNg++;
    } else {
      live.ok++;
    }
    live.last = { t: msg.t, serial: msg.serial, result: msg.result, defect: msg.defect, values: msg.values, cycle: msg.cycle };

    const line = this.lines.get(rt.def.line);
    if (line) {
      if (Number.isNaN(line.startMs)) line.startMs = Date.parse(msg.start);
      const sc = line.steps.get(msg.step) ?? { ok: 0, ng: 0 };
      if (ng) sc.ng++;
      else sc.ok++;
      line.steps.set(msg.step, sc);
      if (ng) line.ng++;
      if (!ng && msg.step === line.def.finalStep) {
        line.output++;
        line.finals.push(Date.parse(msg.t));
      }
    }

    this.feedSpc(rt, msg.values, Date.parse(msg.start), msg.t, true);
    this.feedQuality(rt, ng, msg.t, true);
    this.events.emit('unit', msg);
  }

  /**
   * SPC: 공정값·측정값을 부분군으로 묶어 판정한다.
   * 배치 설비(증착기 24개 등)는 한 배치의 공정값이 모두 같아서, 공정값은 배치마다 하나만 넣는다 (측정값은 개별).
   * alarm = false는 복원 재생: 관리도만 다시 채우고 알람은 내지 않는다 (알람은 DB에서 따로 되살린다)
   */
  private feedSpc(rt: StationRt, values: Record<string, number>, startMs: number, t: string, alarm: boolean): void {
    const sameBatch = (rt.def.batch ?? 1) > 1 && rt.lastStartMs === startMs;
    rt.lastStartMs = startMs;
    for (const [key, v] of Object.entries(values)) {
      const series = rt.spc.get(key);
      if (!series || (sameBatch && series.chart.source !== 'measure')) continue;
      const res = series.add(v, t);
      if (alarm && res?.alarmRule) {
        const c = series.chart;
        this.raise(
          rt.def.code, 'info', 'SPC', `${rt.def.name} · ${c.name} SPC 이상`,
          `${SPC_RULES[res.alarmRule]} · 부분군 평균 ${res.point.mean} ${c.unit} (관리한계 ${c.lcl} ~ ${c.ucl})`, t,
        );
      }
    }
  }

  /** 품질: 최근 40개 불량률. 켜짐(10%)과 꺼짐(5%) 기준을 달리 둬 경계에서 알람이 깜빡이지 않게 한다 */
  private feedQuality(rt: StationRt, ng: boolean, t: string, alarm: boolean): void {
    rt.window.push(ng);
    if (rt.window.length > QUALITY_WINDOW) rt.window.shift();
    const n = rt.window.filter(Boolean).length;
    const rate = n / rt.window.length;
    if (!rt.qualityOn && n >= QUALITY_MIN_NG && rate >= QUALITY_ON) {
      rt.qualityOn = true;
      if (!alarm) return;
      const top = Object.entries(rt.live.defects).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => DEFECT_NAMES[c] ?? c);
      this.raise(rt.def.code, 'warn', 'QUALITY', `${rt.def.name} 불량률 상승 ${(rate * 100).toFixed(0)}%`, `최근 ${rt.window.length}개 중 ${n}개 NG · 주요 불량: ${top.join(', ')}`, t);
    } else if (rt.qualityOn && rate < QUALITY_OFF) {
      rt.qualityOn = false;
    }
  }

  // ───────────── 알람 ─────────────

  private raise(station: string, severity: AlarmLive['severity'], kind: AlarmLive['kind'], title: string, detail: string | undefined, t: string): void {
    const alarm: AlarmLive = { id: ++this.alarmSeq, t, station, severity, kind, title, detail, acked: false };
    this.alarms.unshift(alarm);
    if (this.alarms.length > MAX_ALARMS) this.alarms.pop();
    this.events.emit('alarm', alarm);
  }

  /**
   * 다른 모듈(실행 MES·품질·예지 보전)이 올리는 알람 (P9). 시각을 주지 않으면 지금 가상 시각.
   * 화면 알람 목록·소켓·DB(alarm 표)에 같은 길로 들어간다
   */
  raiseAlarm(station: string, severity: AlarmLive['severity'], kind: AlarmLive['kind'], title: string, detail?: string, t?: string): AlarmLive {
    this.raise(station, severity, kind, title, detail, t ?? this.virtualNow ?? new Date().toISOString());
    return this.alarms[0];
  }

  /** 작업자 태블릿이 올린 알람 (작업 전 점검 이상). 시각은 지금 가상 시각 */
  raiseFromOperator(station: string, kind: AlarmLive['kind'], title: string, detail?: string): AlarmLive {
    this.raise(station, 'warn', kind, title, detail, this.virtualNow ?? new Date().toISOString());
    return this.alarms[0];
  }

  ack(id: number): AlarmLive | null {
    const a = this.alarms.find((x) => x.id === id);
    if (!a) return null;
    if (!a.acked) {
      a.acked = true;
      this.events.emit('ack', id, new Date(this.nowMs || Date.now()).toISOString(), a.t);
    }
    return a;
  }

  // ───────────── 계산 ─────────────

  private stationTimes(rt: StationRt): Partial<Record<StationState, number>> {
    const times = { ...rt.live.stateSec };
    if (!Number.isNaN(rt.sinceMs)) {
      const s = rt.live.state;
      times[s] = (times[s] ?? 0) + Math.max(0, this.nowMs - rt.sinceMs) / 1000;
    }
    return times;
  }

  /** OEE 계산식은 oee.ts (테스트가 같은 함수를 확인한다) */
  private stationOee(rt: StationRt, times: StateTimes): Oee {
    return stationOee(times, { ok: rt.live.ok, ng: rt.live.ng, idealSec: rt.idealSec, utility: rt.utility });
  }

  private lineLive(line: LineRt, stations: Record<string, StationLive>): LineLive {
    let fpy = 1;
    for (const { ok, ng } of line.steps.values()) if (ok + ng > 0) fpy *= ok / (ok + ng);
    const hourAgo = this.nowMs - 3_600_000;
    while (line.finals.length && line.finals[0] < hourAgo) line.finals.shift();
    const own = line.def.stations.filter((s) => s.cycle > 0).map((s) => stations[s.code]);
    const availability = own.length ? own.reduce((a, s) => a + s.oee.availability, 0) / own.length : 1;
    // 라인 OEE = 양품 완성 수 × 택트 ÷ 경과 시간 (완전 생산 시간 ÷ 계획 시간)
    const elapsed = Number.isNaN(line.startMs) ? 0 : (this.nowMs - line.startMs) / 1000;
    const oee = elapsed > 0 ? Math.min(1, (line.output * line.def.taktSec) / elapsed) : 0;
    const aq = availability * fpy;
    return {
      code: line.def.code,
      output: line.output,
      ng: line.ng,
      fpy: r3(fpy),
      oee: { availability: r3(availability), quality: r3(fpy), performance: r3(aq > 0 ? Math.min(1, oee / aq) : 0), oee: r3(oee) },
      lastHour: line.finals.length,
      downStations: own.filter((s) => s.state === 'DOWN').map((s) => s.code),
    };
  }

  tick(): TickPayload {
    const stations: Record<string, StationLive> = {};
    for (const [code, rt] of this.stations) {
      const times = this.stationTimes(rt);
      rt.live.oee = this.stationOee(rt, times);
      stations[code] = { ...rt.live, stateSec: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)])) };
    }
    const lines: Record<string, LineLive> = {};
    for (const [code, line] of this.lines) lines[code] = this.lineLive(line, stations);
    const now = Date.now();
    return {
      sim: this.sim,
      stations,
      lines,
      amrs: this.amrs,
      edge: this.edge,
      connected: { sim: now - this.lastSimAt < SIM_TIMEOUT_MS, edge: now - this.lastEdgeAt < EDGE_TIMEOUT_MS },
    };
  }

  /**
   * 6대 로스: 설비별 시간 구성과 라인·공장 합계 (계산식은 losses.ts).
   * 초기 수율 로스는 메모리에서만 센다: 서버를 다시 띄우면 그 뒤 재가동부터 다시 센다 (그 전 불량은 공정 불량으로 들어간다)
   */
  losses(): LossReport {
    const stations: StationLoss[] = [];
    for (const rt of this.stations.values()) {
      const { ok, ng } = rt.live;
      const lt = stationLosses(this.stationTimes(rt), { ok, ng, startupNg: rt.startupNg, idealSec: rt.idealSec, utility: rt.utility });
      stations.push({ station: rt.def.code, line: rt.def.line, ok, ng, startupNg: rt.startupNg, ...lt });
    }
    return {
      t: this.virtualNow,
      startupWindowSec: STARTUP_WINDOW_SEC,
      total: roundLosses(sumLosses(stations)),
      lines: LINES.map((l) => ({ line: l.code, ...roundLosses(sumLosses(stations.filter((s) => s.line === l.code))) })),
      stations: stations.map(roundLosses),
    };
  }

  snapshot(): LiveSnapshot {
    return { ...this.tick(), alarms: this.alarms };
  }

  spc(station: string): SpcChart[] {
    const rt = this.stations.get(station);
    return rt ? [...rt.spc.values()].map((s) => s.chart) : [];
  }

  /** 알람이 켜진 특성 위주로, 모든 설비의 관리도 요약 (챗봇·대시보드용) */
  spcSummary(): (Omit<SpcChart, 'points'> & { last?: SpcChart['points'][number]; flagged: number })[] {
    const out = [];
    for (const rt of this.stations.values()) {
      for (const s of rt.spc.values()) {
        const { points, ...rest } = s.chart;
        out.push({ ...rest, last: points[points.length - 1], flagged: points.slice(-10).filter((p) => p.flags.length).length });
      }
    }
    return out;
  }

  get alarmList(): AlarmLive[] {
    return this.alarms;
  }

  get currentRun(): string | null {
    return this.runStartedAt;
  }

  get virtualNow(): string | null {
    return this.nowMs ? new Date(this.nowMs).toISOString() : null;
  }

  // ───────────── 복원 ─────────────

  /** 복원에 필요한 설비별 최근 기록 수: 관리도 80점 × 부분군 5개 (배치 설비는 공정값이 배치마다 하나라 배치 수만큼 더) */
  restorePlan(): { stations: string[]; depth: number[]; finalSteps: string[]; maxAlarms: number } {
    const defs = [...this.stations.values()].map((rt) => rt.def);
    return {
      stations: defs.map((d) => d.code),
      depth: defs.map((d) => Math.max(QUALITY_WINDOW, SPC_KEEP_POINTS * SPC_SUBGROUP * (d.batch ?? 1))),
      finalSteps: [...new Set(LINES.map((l) => l.finalStep))],
      maxAlarms: MAX_ALARMS,
    };
  }

  /**
   * DB에서 다시 모은 실행 상태로 메모리 집계를 채운다. 서버 시작 때 MQTT 수신 전에 한 번 부른다.
   * 서버가 내려가 있던 동안의 시간은 마지막으로 기록된 상태에 들어간다 (그동안의 상태 변화는 시뮬레이터만 안다).
   * 시뮬레이터 실행이 그사이 바뀌었으면 첫 상태 메시지에서 onStatus가 알아서 새로 시작한다.
   */
  hydrate(h: LiveHydration): void {
    this.reset();
    this.runStartedAt = h.startedAt;
    this.nowMs = h.nowMs;
    const runStart = Date.parse(h.startedAt);

    for (const c of h.counts) {
      const rt = this.stations.get(c.station);
      if (!rt) continue;
      const ng = c.result === 'NG';
      if (ng) {
        rt.live.ng += c.n;
        if (c.defect) rt.live.defects[c.defect] = (rt.live.defects[c.defect] ?? 0) + c.n;
      } else {
        rt.live.ok += c.n;
      }
      const line = this.lines.get(rt.def.line);
      if (!line) continue;
      const first = c.firstStart.getTime();
      if (Number.isNaN(line.startMs) || first < line.startMs) line.startMs = first;
      const sc = line.steps.get(c.step) ?? { ok: 0, ng: 0 };
      if (ng) {
        sc.ng += c.n;
        line.ng += c.n;
      } else {
        sc.ok += c.n;
        if (c.step === line.def.finalStep) line.output += c.n;
      }
      line.steps.set(c.step, sc);
    }
    for (const f of h.finals) {
      const line = this.lines.get(this.stations.get(f.station)?.def.line ?? '');
      if (line && f.step === line.def.finalStep) line.finals.push(f.at.getTime());
    }

    // 상태 시간: 닫힌 구간 합 + 첫 상태 변화 전 초기 상태 구간. 마지막 상태는 열린 구간으로 두어 tick()이 이어 센다
    const states = new Map<string, LiveHydration['states']>();
    for (const s of h.states) states.set(s.station, [...(states.get(s.station) ?? []), s]);
    for (const [code, rt] of this.stations) {
      const live = rt.live;
      const rows = states.get(code) ?? [];
      if (!rows.length) {
        rt.sinceMs = runStart;
        live.since = h.startedAt;
        continue;
      }
      const firstAt = Math.min(...rows.map((r) => r.firstAt.getTime()));
      live.stateSec[live.state] = Math.max(0, firstAt - runStart) / 1000;
      for (const r of rows) {
        const s = r.state as StationState;
        if (r.sec > 0) live.stateSec[s] = (live.stateSec[s] ?? 0) + r.sec;
        if (r.openAt) {
          live.state = s;
          live.reason = r.openReason ?? undefined;
          live.since = r.openAt.toISOString();
          rt.sinceMs = r.openAt.getTime();
        }
        if (r.upAt) rt.upAtMs = Math.max(rt.upAtMs, r.upAt.getTime());
      }
    }

    // 관리도·최근 불량률 창은 최근 기록을 순서대로 다시 흘려 만든다 (알람 없이)
    for (const [code, recs] of h.recent) {
      const rt = this.stations.get(code);
      if (!rt) continue;
      for (const r of recs) {
        const t = r.end.toISOString();
        this.feedSpc(rt, r.values, r.start.getTime(), t, false);
        this.feedQuality(rt, r.result === 'NG', t, false);
      }
      const last = recs[recs.length - 1];
      if (last) rt.live.last = { t: last.end.toISOString(), serial: last.serial, result: last.result, defect: last.defect ?? undefined, values: last.values, cycle: last.cycle };
    }

    // 알람: 같은 번호가 여럿이면(예전 서버 재시작으로 번호가 겹친 기록) 가장 새것만 둔다. 새 알람 번호는 기록된 최댓값 다음부터
    const seen = new Set<number>();
    this.alarms = h.alarms.filter((a) => !seen.has(a.id) && seen.add(a.id)).slice(0, MAX_ALARMS);
    this.alarmSeq = h.alarmSeq;
    // 이미 알람을 낸 규격 이탈은 다시 내지 않는다. 지금 규격 안이면 3틱 뒤 저절로 풀린다
    for (const { station, title } of h.limitAlarms) {
      const rt = this.stations.get(station);
      const td = rt?.def.tags.find((x) => limitTitle(rt, x.name) === title);
      if (rt && td) rt.limitOn.add(td.key);
    }
  }

  // ───────────── 초기화 ─────────────

  private reset(): void {
    this.nowMs = 0;
    this.staleDropped = 0;
    this.sim = null;
    this.amrs = {};
    this.alarms = [];
    this.stations = new Map(
      Object.values(STATIONS).map((def) => {
        const utility = def.cycle <= 0 || !!def.aux;
        const live: StationLive = {
          code: def.code, state: utility ? 'RUN' : 'IDLE', since: new Date().toISOString(), tags: {}, ok: 0, ng: 0, defects: {},
          oee: { availability: 1, performance: 0, quality: 1, oee: 0 }, stateSec: {},
        };
        // 연배 분할(split) 공정은 한 사이클에 개체 메시지가 split개 온다 (P9)
        const split = LINES.find((l) => l.code === def.line)?.steps.find((s) => s.code === def.step)?.split ?? 1;
        const idealSec = utility ? 0 : def.cycle / ((def.slots ?? 1) * (def.batch ?? 1) * split);
        return [def.code, {
          def, live, sinceMs: NaN, idealSec, utility, window: [], qualityOn: false,
          limitRun: new Map(), limitOn: new Set(), upAtMs: 0, spc: buildSeries(def), lastStartMs: NaN,
          restartMs: -Infinity, startupNg: 0,
        } satisfies StationRt];
      }),
    );
    this.lines = new Map(LINES.map((def) => [def.code, { def, startMs: NaN, output: 0, ng: 0, finals: [], steps: new Map() }]));
  }
}
