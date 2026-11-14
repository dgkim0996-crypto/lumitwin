import { Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  HEALTH_LEVEL_NAMES,
  PM_REASON,
  STATIONS,
  VIB_ZONES,
  vibLevel,
  type HealthMsg,
  type HealthView,
  type SimEventMsg,
  type SimStatusMsg,
  type StationDef,
  type StationHealth,
  type StationHealthDetail,
  type StationState,
} from '@lumitwin/shared';
import { LiveService } from '../live/live.service';
import { outOfRun } from '../live/run-clock';
import { MqttBrokerService, type MqttInbound } from '../mqtt/mqtt-broker.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from '../production/production.writer';
import { armedOf, decimate, estimateRul, healthIndex, pdmStep, runningOnly, smoothedVib, type Armed, type Sample } from './health-calc';

const HOUR = 3_600_000;
/** 설비마다 메모리에 들고 있는 표본 수 (가상 1분 간격이면 하루) */
const KEEP = 1440;
/** 추이 그래프: 최근 이 시간(가상)의 가동 표본을 최대 TREND_POINTS점으로 */
const TREND_H = 12;
const TREND_POINTS = 120;
const FLUSH_MS = 2_000;
const MAX_QUEUE = 20_000;

type Monitored = StationDef & { line: string; health: NonNullable<StationDef['health']> };

interface Mem {
  samples: Sample[];
  armed: Armed;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 예지 보전 (상태 감시). 시뮬레이터가 가상 1분마다 보내는 진동·전류·온도(health 토픽)를 받아
 * 1) 실행 구간 밖 시각은 버리고 2) 메모리에 최근 값을 들고 3) DB(health_sample)에 모아 쓰고
 * 4) 진동이 ISO 10816 구역 경계를 넘으면 PDM 알람을 낸다 (B/C 경고, C/D 위험, 등급이 오를 때 한 번씩).
 */
@Injectable()
export class HealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Health');
  /** 시뮬레이터 상태 (실행 구간 판단용) */
  private sim: Pick<SimStatusMsg, 'startedAt' | 't' | 'speed'> | null = null;
  /** 메모리가 담고 있는 실행 (시작 시각 ms) */
  private runMs: number | null = null;
  private mem = new Map<string, Mem>();
  private maint = new Map<string, { kind: 'pm' | 'repair'; at: number }>();
  private lastState = new Map<string, { state: StationState; reason?: string }>();
  private queue: { run: string; station: string; s: Sample }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private stale = 0;
  received = 0;

  constructor(
    private readonly mqtt: MqttBrokerService,
    private readonly live: LiveService,
    private readonly writer: ProductionWriter,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.restore().catch((e) => this.logger.warn(`상태 감시 기록을 되살리지 못했습니다: ${(e as Error).message}`));
    this.mqtt.onMessage((m) => this.receive(m));
    this.live.events.on('run', (startedAt) => this.useRun(Date.parse(startedAt)));
    this.live.events.on('state', (station, state, reason, t) => this.onState(station, state, reason, t));
    this.live.events.on('event', (msg) => this.onEvent(msg));
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  // ───────────── 수집 ─────────────

  private receive({ parts, payload }: MqttInbound): void {
    if (parts[0] === 'sim') {
      if (parts[1] === 'status') {
        const s = payload as SimStatusMsg;
        this.sim = { startedAt: s.startedAt, t: s.t, speed: s.speed };
      } else if (parts[1] === 'event' && (payload as SimEventMsg)?.kind === 'reset') {
        this.sim = null;
      }
      return;
    }
    if (parts.length !== 3 || parts[2] !== 'health') return;
    const def = monitored(parts[1]);
    if (!def) return;
    const msg = payload as HealthMsg;
    const t = Date.parse(msg?.t ?? '');
    const v = msg?.v;
    if (!Number.isFinite(t) || !v || ![v.vib, v.cur, v.temp].every((x) => typeof x === 'number' && Number.isFinite(x))) return;
    // 실행을 아직 모르거나(첫 상태 메시지 전) 지금 실행의 시각이 아니면 버린다 (run-clock.ts: 초기화 직후 이전 실행의 늦은 값)
    if (!this.sim) return;
    if (outOfRun(t, this.sim)) {
      if (this.stale++ === 0) this.logger.warn(`지금 실행의 시각이 아닌 상태 감시 값을 버렸습니다: ${def.code} ${msg.t}`);
      return;
    }
    const run = this.sim.startedAt;
    this.useRun(Date.parse(run));
    this.received++;
    const s: Sample = { t, vib: v.vib, cur: v.cur, temp: v.temp };
    const m = this.memOf(def.code);
    const last = m.samples[m.samples.length - 1];
    if (last && t < last.t) {
      // 늦게 온 값: 순서를 맞춰 끼운다
      const i = m.samples.findIndex((x) => x.t > t);
      m.samples.splice(i, 0, s);
    } else {
      m.samples.push(s);
    }
    if (m.samples.length > KEEP) m.samples.splice(0, m.samples.length - KEEP);
    this.queue.push({ run, station: def.code, s });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this.judge(def, m, msg.t);
  }

  /** 등급이 오르면 PDM 알람 (B/C 경고 · C/D 위험), 보전 뒤 내려가면 다시 무장 */
  private judge(def: Monitored, m: Mem, t: string): void {
    const vib = smoothedVib(m.samples, def.health.vib);
    if (vib == null) return;
    const z = VIB_ZONES[def.health.cls];
    const step = pdmStep(m.armed, vib, z);
    m.armed = step.armed;
    if (!step.raise) return;
    const nowMs = Date.parse(t);
    const { rul } = estimateRul(m.samples, { baseVib: def.health.vib, zones: z, nowMs, sinceMs: this.maint.get(def.code)?.at });
    const left = rul ? (step.raise === 'warn' ? ` · 위험 구역까지 약 ${rul.dangerH}시간 (추세 외삽)` : '') : '';
    const edge = step.raise === 'critical' ? `C/D ${z.cd}` : `B/C ${z.bc}`;
    const title = step.raise === 'critical' ? `${def.name} 진동 위험 · 즉시 보전` : `${def.name} 진동 경고 · 보전 계획`;
    const detail = `진동 ${r2(vib)} mm/s ≥ ${edge} mm/s (ISO 10816 등급 ${def.health.cls}, ${HEALTH_LEVEL_NAMES[step.raise === 'critical' ? 'danger' : 'warn']}) · ${def.health.part} 마모 의심${left}`;
    this.live.raiseAlarm(def.code, step.raise, 'PDM', title, detail, t);
  }

  private memOf(code: string): Mem {
    let m = this.mem.get(code);
    if (!m) {
      m = { samples: [], armed: 0 };
      this.mem.set(code, m);
    }
    return m;
  }

  /** 실행이 바뀌면 메모리를 비운다 */
  private useRun(ms: number): void {
    if (!Number.isFinite(ms) || this.runMs === ms) return;
    if (this.runMs != null) this.logger.log('시뮬레이터 실행이 바뀌어 상태 감시 값을 새로 모읍니다');
    this.runMs = ms;
    this.mem.clear();
    this.maint.clear();
    this.lastState.clear();
  }

  /** 보전 시각: 고장(DOWN)에서 벗어난 때(수리), 계획 보전 정지에서 벗어난 때(예방·예지 보전) */
  private onState(station: string, state: StationState, reason: string | undefined, t: string): void {
    const prev = this.lastState.get(station);
    const at = Date.parse(t);
    if (prev && Number.isFinite(at)) {
      if (prev.state === 'DOWN' && state !== 'DOWN') this.setMaint(station, 'repair', at);
      else if (prev.state === 'STOP' && prev.reason === PM_REASON && state !== 'STOP') this.setMaint(station, 'pm', at);
    }
    this.lastState.set(station, { state, reason });
  }

  private onEvent(msg: SimEventMsg): void {
    if (msg.kind === 'pm' && msg.station) this.setMaint(msg.station, 'pm', Date.parse(msg.t));
  }

  private setMaint(station: string, kind: 'pm' | 'repair', at: number): void {
    if (!Number.isFinite(at) || !monitored(station)) return;
    const cur = this.maint.get(station);
    if (!cur || at >= cur.at) this.maint.set(station, { kind, at });
  }

  // ───────────── DB ─────────────

  private async flush(): Promise<void> {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      const byRun = new Map<string, typeof batch>();
      for (const q of batch) byRun.set(q.run, [...(byRun.get(q.run) ?? []), q]);
      for (const [run, items] of byRun) {
        const runId = await this.writer.resolveRun(run);
        await this.prisma.healthSample.createMany({
          data: items.map((q) => ({ runId, station: q.station, at: new Date(q.s.t), vib: q.s.vib, cur: q.s.cur, temp: q.s.temp })),
        });
      }
    } catch (e) {
      this.logger.error(`상태 감시 기록 실패, 다시 시도합니다: ${(e as Error).message}`);
      this.queue = [...batch, ...this.queue].slice(-MAX_QUEUE);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 서버를 다시 띄울 때: 지금 실행(실시간 집계를 되살린 실행)의 최근 표본·마지막 보전을 DB에서 가져온다.
   * 이미 넘은 등급의 알람은 다시 내지 않도록 무장 상태를 지금 진동으로 맞춘다
   */
  private async restore(): Promise<void> {
    const runId = this.writer.currentRunId;
    const cur = Date.parse(this.live.currentRun ?? '');
    if (runId == null || !Number.isFinite(cur)) return;
    const run = await this.prisma.simRun.findUnique({ where: { id: runId } });
    if (!run || run.startedAt.getTime() !== cur) return;
    const codes = monitoredCodes();
    if (!codes.length) return;
    const [rows, maint] = await Promise.all([
      this.prisma.$queryRaw<{ station: string; at: Date; vib: number; cur: number; temp: number }[]>`
        SELECT s.code AS station, h.at, h.vib, h.cur, h.temp
        FROM unnest(${codes}::text[]) AS s(code)
        CROSS JOIN LATERAL (
          SELECT at, vib, cur, temp FROM health_sample
          WHERE run_id = ${runId} AND station = s.code
          ORDER BY at DESC LIMIT ${KEEP}::int
        ) h
        ORDER BY s.code, h.at`,
      this.prisma.$queryRaw<{ station: string; state: string; end: Date }[]>`
        SELECT DISTINCT ON (station) station, state, "end" FROM (
          SELECT station, state, reason, lead(at) OVER (PARTITION BY station ORDER BY at, id) AS "end"
          FROM state_event WHERE run_id = ${runId} AND station = ANY(${codes}::text[])
        ) e
        WHERE "end" IS NOT NULL AND (state = 'DOWN' OR (state = 'STOP' AND reason = ${PM_REASON}))
        ORDER BY station, "end" DESC`,
    ]);
    this.runMs = cur;
    for (const r of rows) this.memOf(r.station).samples.push({ t: r.at.getTime(), vib: r.vib, cur: r.cur, temp: r.temp });
    for (const r of maint) this.maint.set(r.station, { kind: r.state === 'DOWN' ? 'repair' : 'pm', at: r.end.getTime() });
    for (const code of codes) {
      const def = monitored(code)!;
      const m = this.mem.get(code);
      if (m) m.armed = armedOf(smoothedVib(m.samples, def.health.vib), VIB_ZONES[def.health.cls]);
    }
    if (rows.length) this.logger.log(`상태 감시 복원: 실행 #${runId} · 설비 ${this.mem.size}대 · 표본 ${rows.length}건`);
  }

  // ───────────── 조회 ─────────────

  view(): HealthView {
    const codes = monitoredCodes();
    return {
      t: this.live.virtualNow,
      runStartedAt: this.runMs != null ? new Date(this.runMs).toISOString() : this.live.currentRun,
      stations: codes.map((c) => this.stationView(monitored(c)!)),
      unmonitored: Object.keys(STATIONS).length - codes.length,
    };
  }

  detail(code: string): StationHealthDetail {
    if (!STATIONS[code]) throw new NotFoundException(`설비 ${code}이(가) 없습니다`);
    const def = monitored(code);
    if (!def) throw new NotFoundException(`${code}은(는) 상태 감시 대상이 아닙니다 (공장 정의에 health 없음)`);
    const m = this.mem.get(code);
    return {
      ...this.stationView(def),
      history: (m?.samples ?? []).map((s) => ({ t: new Date(s.t).toISOString(), vib: r2(s.vib), cur: r2(s.cur), temp: r2(s.temp) })),
    };
  }

  private stationView(def: Monitored): StationHealth {
    const h = def.health;
    const z = VIB_ZONES[h.cls];
    const m = this.mem.get(def.code);
    const samples = m?.samples ?? [];
    const last = samples[samples.length - 1];
    const vib = smoothedVib(samples, h.vib);
    const nowMs = Date.parse(this.live.virtualNow ?? '') || last?.t || 0;
    const maint = this.maint.get(def.code) ?? null;
    const { rul, note } = estimateRul(samples, { baseVib: h.vib, zones: z, nowMs, sinceMs: maint?.at });
    const trend = decimate(
      runningOnly(samples, h.vib)
        .filter((s) => s.t >= nowMs - TREND_H * HOUR)
        .map((s) => ({ t: s.t, vib: s.vib })),
      TREND_POINTS,
    );
    return {
      station: def.code,
      line: def.line as StationHealth['line'],
      part: h.part,
      cls: h.cls,
      zones: z,
      base: { vib: h.vib, cur: h.cur, temp: h.temp },
      grade: h.grade,
      latest: last ? { t: new Date(last.t).toISOString(), vib: r2(last.vib), cur: r2(last.cur), temp: r2(last.temp) } : null,
      vib: vib != null ? r2(vib) : null,
      level: vib != null ? vibLevel(h.cls, vib) : null,
      index: healthIndex(vib, h.vib, z.cd),
      trend: trend.map((p) => ({ t: new Date(p.t).toISOString(), vib: r2(p.vib) })),
      rul,
      rulNote: samples.length ? note : '아직 받은 표본이 없습니다',
      lastMaint: maint ? { kind: maint.kind, at: new Date(maint.at).toISOString() } : null,
      samples: samples.length,
    };
  }
}

function monitored(code: string): Monitored | null {
  const d = STATIONS[code];
  return d?.health ? (d as Monitored) : null;
}

function monitoredCodes(): string[] {
  return Object.keys(STATIONS).filter((c) => !!STATIONS[c].health);
}
