import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  DEFECT_NAMES,
  EXEC_NOTE_MAX,
  FACTORY,
  HOLD_KIND_NAMES,
  HOLD_SERIALS_MAX,
  ILK_RETRY_SEC,
  INTERLOCK_NAMES,
  LINES,
  STATIONS,
  TOPICS,
  WO_LOT,
  WO_QTY_MAX,
  defaultDisposition,
  inProductScope,
  lineOf,
  woCode,
  type ActorInfo,
  type Disposition,
  type ExecutionSummary,
  type HoldCreate,
  type HoldDetail,
  type HoldImpact,
  type HoldKind,
  type HoldList,
  type HoldReleaseInput,
  type HoldResult,
  type HoldStatus,
  type HoldView,
  type IlkReqMsg,
  type IlkResMsg,
  type InterlockCode,
  type InterlockCount,
  type InterlockReport,
  type LineCode,
  type LineExecution,
  type NcrDetail,
  type NcrDisposeInput,
  type NcrList,
  type NcrStatus,
  type NcrView,
  type QuarantineView,
  type RepairMsg,
  type UnitMsg,
  type WoPlanSlot,
  type WoReqMsg,
  type WoResMsg,
  type WoSource,
  type WoStatus,
  type WorkOrderCreate,
  type WorkOrderPatch,
  type WorkOrderReorder,
  type WorkOrderView,
} from '@lumitwin/shared';
import { AuditService } from '../auth/audit.service';
import { Prisma } from '../generated/prisma/client';
import { LiveService } from '../live/live.service';
import { MqttBrokerService, type MqttInbound } from '../mqtt/mqtt-broker.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter, type UnitStatus } from '../production/production.writer';
import { QualitySystemService } from '../quality-system/quality-system.service';
import { decide, lotKey, type HoldHit, type IlkContext, type IlkDecision, type UnitMem } from './interlock';
import {
  AUTO_DECIDER,
  applyReinspect,
  applyRepair,
  awaitingReinspect,
  canDispose,
  holdCode,
  initialDisposition,
  kstDay,
  maxSeq,
  ncrCode,
  outcome,
  statusAfter,
  summarize,
  unitStatusAfter,
  woDone,
  type NcrState,
} from './ncr-rules';
import { autoFill, reorder, schedule, type PlanOrder } from './planner';

/** 작업지시 진척·인터록 기록을 DB에 모아 쓰는 간격 */
const FLUSH_MS = 1_000;
/** 복원 중 붙잡아 둘 최대 메시지 수 */
const MAX_PENDING = 20_000;
/** 개체 기억 상한. 넘으면 끝난(완성·폐기) 개체부터 잊는다 */
const MAX_UNITS = 200_000;
/** 같은 설비·같은 사유의 인터록 거부 알람은 이 간격(가상 분)에 한 번만 (assumed) */
const ILK_ALARM_MIN = 30;
/** MRB 판정 대기 알람: 설비마다 이 간격(가상 분)에 한 번만 (assumed) */
const MRB_ALARM_MIN = 10;
/** 폐기 판정 Hold 대상을 게이트에서 거부한 뒤 폐기 명령을 보내기까지 (실제 ms). 시뮬레이터가 격리 구역에 넣은 다음이어야 한다 */
const SCRAP_DELAY_MS = ILK_RETRY_SEC * 1000 + 500;
/** 지난(완료·중단) 작업지시: 라인마다 이만큼 보여 준다 */
const HISTORY_PER_LINE = 30;
const NCR_LIST_MAX = 300;
const IMPACT_MAX = 5000;
const IMPACT_TOPS = 500;
const MAX_DEPTH = 5;
const ILK_RECENT = 100;

const LINE_CODES = new Set<string>(LINES.map((l) => l.code));
const stationName = (code: string) => STATIONS[code]?.name ?? code;
/** 자재 → 그 자재를 처음 쓰는 설비 (LOT Hold 알람 위치) */
const MATERIAL_STATION: Record<string, string> = {};
for (const l of LINES) for (const s of l.steps) for (const i of s.inputs) if (i.material) MATERIAL_STATION[i.material] ??= l.stations.find((st) => st.step === s.code)?.code ?? '';
const RELEASE_KEYS = LINES.map((l) => `${l.code}.${l.release}`);

interface WoRt {
  id: number;
  code: string;
  line: LineCode;
  variant: string;
  qty: number;
  seq: number;
  status: WoStatus;
  released: number;
  doneQty: number;
  scrapQty: number;
  source: WoSource;
  createdBy: string | null;
  note: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** 투입 공정 실적으로 센 투입 수 (시뮬레이터가 투입 끝을 알려 주기 전 진척) */
  seen: number;
}

type NcrRt = NcrState & { runId: number };

interface HoldRt {
  id: number;
  code: string;
  kind: HoldKind;
  material: string | null;
  lot: string | null;
  serials: string[];
  reason: string;
  status: HoldStatus;
  createdBy: string | null;
  createdAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseNote: string | null;
  result: HoldResult | null;
  /** Hold 시리얼과 그 시리얼이 이미 조립된 상위 제품 */
  covers: Set<string>;
  lotKey: string | null;
}

/** 격리 구역의 투입 묶음 (인터록 NG) */
interface QuarRt {
  serial: string;
  comps: string[];
  line: LineCode;
  station: string;
  step: string;
  code: InterlockCode;
  reason: string;
  holdId: number | null;
  wo: number | null;
  variant: string | null;
  /** 묶음이 쓴(쓸) 자재 LOT */
  lots: string[];
  at: string;
}

type Pending = { kind: 'unit'; msg: UnitMsg } | { kind: 'repair'; msg: RepairMsg } | { kind: 'wo'; msg: WoReqMsg };

interface IlkLogRow {
  runId: number;
  line: string;
  station: string;
  step: string;
  serial: string;
  verdict: string;
  code: string;
  reason: string;
  comps: string[];
  at: Date;
}

const zeroCount = (): InterlockCount => ({ ok: 0, ng: 0, wait: 0 });
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/**
 * 실행 MES (P9): 작업지시·생산 계획, 공정 인터록, 불량 처리(NCR), Hold.
 * 시뮬레이터 요청(인터록·작업지시)은 메모리로 바로 답하고, DB 기록은 뒤따라 순서대로 쓴다 (수집 경로가 DB를 기다리지 않게).
 * 실행이 바뀌면 메모리를 비우고 그 실행의 기록을 DB에서 되살린 뒤(새 실행이면 비어 있다) 자동 계획을 채운다.
 */
@Injectable()
export class ExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Execution');

  private runId: number | null = null;
  private runStartedAt: string | null = null;
  /** 지금 실행의 기록을 되살렸나. 전에는 인터록에 WAIT로 답하고 나머지 메시지는 붙잡아 둔다 */
  private ready = false;
  /** 실행이 바뀔 때마다 늘린다. 늦게 끝난 비동기 작업이 새 실행의 메모리를 건드리지 않게 */
  private gen = 0;
  private pending: Pending[] = [];

  private units = new Map<string, UnitMem>();
  private wos = new Map<number, WoRt>();
  private ncrs: NcrRt[] = [];
  private ncrBySerial = new Map<string, NcrRt[]>();
  private holds = new Map<number, HoldRt>();
  private quarantine = new Map<string, QuarRt>();
  /** 라인마다 마지막으로 내려 준 작업지시 */
  private lastDispatch = new Map<LineCode, number>();

  /** 인터록: 설비별 판정 수 (메모리), ROUTE 대기를 처음 답한 실제 시각, 마지막으로 기록한 WAIT 사유 */
  private ilk = new Map<string, InterlockCount>();
  private ilkSince: string | null = null;
  private routeWait = new Map<string, number>();
  private waitLogged = new Map<string, string>();
  private alarmAt = new Map<string, number>();
  private noPlan = new Set<LineCode>();
  private codeSeq = new Map<string, number>();

  /** DB 쓰기 줄 (순서 보장), 모아 쓰는 작업지시·인터록 기록 */
  private dbq: Promise<void> = Promise.resolve();
  private dirtyWo = new Map<number, WoRt>();
  private ilkLogs: IlkLogRow[] = [];
  private woChain = new Map<LineCode, Promise<void>>();
  private planChain = new Map<LineCode, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly mqtt: MqttBrokerService,
    private readonly writer: ProductionWriter,
    private readonly quality: QualitySystemService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.mqtt.onMessage((m) => this.receive(m));
    // 개체 실적은 실시간 계층이 실행을 확인한 것만 받는다 (다른 실행의 늦은 메시지는 거기서 버린다)
    this.live.events.on('unit', (msg) => this.accept({ kind: 'unit', msg }));
    this.live.events.on('run', (startedAt) => this.onRun(startedAt));
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    // 기동: 실시간 계층이 되살린 실행이 있으면 그 실행의 작업지시·NCR·Hold·개체를 되살린다 (브로커는 초기화가 끝난 뒤 열린다)
    const run = this.live.currentRun;
    if (run) void this.switchRun(run);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.flush();
    await this.dbq;
  }

  // ───────────── 수신 ─────────────

  private receive({ parts, payload }: MqttInbound): void {
    const [line, a, b, c] = parts;
    if (!LINE_CODES.has(line) || !payload || typeof payload !== 'object') return;
    if (a === 'wo' && b === 'req') return this.accept({ kind: 'wo', msg: { ...(payload as WoReqMsg), line: line as LineCode } });
    if (a === 'repair' && b == null) return this.accept({ kind: 'repair', msg: { ...(payload as RepairMsg), line: line as LineCode } });
    if (b === 'ilk' && c === 'req') this.onIlkReq({ ...(payload as IlkReqMsg), line: line as LineCode, station: a });
  }

  private accept(p: Pending): void {
    if (!this.ready) {
      if (this.pending.length < MAX_PENDING) this.pending.push(p);
      return;
    }
    this.apply(p);
  }

  private apply(p: Pending): void {
    try {
      if (p.kind === 'unit') this.applyUnit(p.msg);
      else if (p.kind === 'repair') this.applyRepair(p.msg);
      else this.queueWoReq(p.msg);
    } catch (e) {
      this.logger.error(`처리 실패 (${p.kind}): ${(e as Error).message}`);
    }
  }

  // ───────────── 실행 전환·복원 ─────────────

  private onRun(startedAt: string): void {
    if (startedAt === this.runStartedAt) return; // 이미 이 실행 (기동 복원 중이거나 끝남)
    void this.switchRun(startedAt);
  }

  private async switchRun(startedAt: string): Promise<void> {
    const gen = ++this.gen;
    this.ready = false;
    this.reset();
    this.runStartedAt = startedAt;
    const t0 = Date.now();
    try {
      const runId = await this.writer.resolveRun(startedAt);
      if (gen !== this.gen) return;
      this.runId = runId;
      const data = await this.load(runId);
      if (gen !== this.gen) return;
      this.hydrate(data);
      this.logger.log(
        `실행 #${runId} 실행 MES 복원: 작업지시 ${this.wos.size} · NCR ${this.ncrs.length} · Hold ${this.holds.size} · 개체 ${this.units.size} · 격리 ${this.quarantine.size} · ${Date.now() - t0}ms`,
      );
    } catch (e) {
      this.logger.warn(`실행 MES 기록을 되살리지 못했습니다 (메모리만으로 시작): ${(e as Error).message}`);
    }
    if (gen !== this.gen) return;
    this.ilkSince = this.live.virtualNow ?? startedAt;
    this.ready = true;
    const held = this.pending;
    this.pending = [];
    for (const p of held) this.apply(p);
    for (const l of LINES) void this.ensurePlan(l.code);
  }

  private reset(): void {
    this.runId = null;
    this.pending = [];
    this.units.clear();
    this.wos.clear();
    this.ncrs = [];
    this.ncrBySerial.clear();
    this.holds.clear();
    this.quarantine.clear();
    this.lastDispatch.clear();
    this.ilk.clear();
    this.routeWait.clear();
    this.waitLogged.clear();
    this.alarmAt.clear();
    this.noPlan.clear();
    this.codeSeq.clear();
  }

  private async load(runId: number) {
    const [wos, ncrs, holds, units, lotUses, ilkNg, seen] = await Promise.all([
      this.prisma.workOrder.findMany({ where: { runId }, orderBy: { seq: 'asc' } }),
      this.prisma.ncr.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
      this.prisma.hold.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
      this.prisma.productionUnit.findMany({
        where: { runId },
        select: { serial: true, line: true, lastStep: true, lastStation: true, status: true, variant: true, workOrder: true, parentSerial: true },
      }),
      this.prisma.$queryRaw<{ serial: string; material: string; lot: string }[]>`
        SELECT DISTINCT serial, material, lot FROM material_lot_use WHERE run_id = ${runId}`,
      // 격리 구역: 시리얼마다 마지막 인터록 거부 (아직 HOLD 상태인 것만 hydrate에서 남긴다)
      this.prisma.$queryRaw<{ serial: string; line: string; station: string; step: string; code: string; reason: string; comps: string[]; at: Date }[]>`
        SELECT DISTINCT ON (serial) serial, line, station, step, code, reason, comps, at
        FROM interlock_log WHERE run_id = ${runId} AND verdict = 'NG'
        ORDER BY serial, at DESC, id DESC`,
      this.prisma.$queryRaw<{ wo: number; n: number }[]>`
        SELECT work_order AS wo, count(DISTINCT serial)::int AS n FROM process_record
        WHERE run_id = ${runId} AND work_order IS NOT NULL AND (line || '.' || step) = ANY(${RELEASE_KEYS}::text[])
        GROUP BY work_order`,
    ]);
    return { wos, ncrs, holds, units, lotUses, ilkNg, seen };
  }

  private hydrate(d: Awaited<ReturnType<ExecutionService['load']>>): void {
    const runId = this.runId!;
    for (const n of d.ncrs) {
      const rt: NcrRt = {
        runId, id: n.id, code: n.code, serial: n.serial, item: n.item, line: n.line as LineCode, station: n.station, step: n.step, defect: n.defect,
        variant: n.variant, workOrder: n.workOrder, status: n.status as NcrStatus, disposition: n.disposition as Disposition | null, rule: n.rule as NcrState['rule'],
        decidedBy: n.decidedBy, decidedAt: n.decidedAt?.toISOString() ?? null, repairOk: n.repairOk, repairMin: n.repairMin,
        reinspect: n.reinspect as 'OK' | 'NG' | null, attempt: n.attempt, openedAt: n.openedAt.toISOString(), closedAt: n.closedAt?.toISOString() ?? null, note: n.note,
      };
      this.indexNcr(rt);
    }
    // 개체 지도: 상태에서 마지막 판정을 되살린다 (수리대·폐기도 불량 판정 뒤다). 처리 안 끝난 NCR이 있으면 불량
    for (const u of d.units) {
      const last = this.ncrBySerial.get(u.serial)?.at(-1);
      const ng = u.status === 'NG' || u.status === 'REPAIR' || u.status === 'SCRAP' || (last != null && last.status !== 'CLOSED') || last?.disposition === 'UAI';
      this.units.set(u.serial, {
        line: u.line as LineCode, lastStep: u.lastStep, lastStation: u.lastStation, lastResult: ng ? 'NG' : 'OK', status: u.status,
        variant: u.variant, wo: u.workOrder, lots: [], parent: u.parentSerial,
      });
    }
    // 자재 LOT: 쓴 개체에서 상위 제품으로 올려 붙인다
    const lots = new Map<string, Set<string>>();
    for (const r of d.lotUses) {
      const k = lotKey(r.material, r.lot);
      let cur: string | null = r.serial;
      for (let i = 0; cur && i <= MAX_DEPTH; i++) {
        let s = lots.get(cur);
        if (!s) lots.set(cur, (s = new Set()));
        s.add(k);
        cur = this.units.get(cur)?.parent ?? null;
      }
    }
    for (const [serial, s] of lots) {
      const u = this.units.get(serial);
      if (u) u.lots = [...s];
    }
    const seen = new Map(d.seen.map((r) => [r.wo, r.n]));
    for (const w of d.wos) {
      this.wos.set(w.id, {
        id: w.id, code: w.code, line: w.line as LineCode, variant: w.variant, qty: w.qty, seq: w.seq, status: w.status as WoStatus,
        released: w.released, doneQty: w.doneQty, scrapQty: w.scrapQty, source: w.source as WoSource, createdBy: w.createdBy, note: w.note,
        createdAt: w.createdAt.toISOString(), startedAt: w.startedAt?.toISOString() ?? null, endedAt: w.endedAt?.toISOString() ?? null, seen: seen.get(w.id) ?? 0,
      });
    }
    // 마지막으로 내려 준 작업지시 = 라인의 진행 중인 것 중 가장 늦게 시작한 것
    for (const w of [...this.wos.values()].filter((x) => x.status === 'RUNNING').sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.seq - b.seq)) {
      this.lastDispatch.set(w.line, w.id);
    }
    for (const h of d.holds) {
      const rt: HoldRt = {
        id: h.id, code: h.code, kind: h.kind as HoldKind, material: h.material, lot: h.lot, serials: h.serials, reason: h.reason, status: h.status as HoldStatus,
        createdBy: h.createdBy, createdAt: h.createdAt.toISOString(), releasedBy: h.releasedBy, releasedAt: h.releasedAt?.toISOString() ?? null,
        releaseNote: h.releaseNote, result: h.result as HoldResult | null, covers: this.coversOf(h.serials), lotKey: h.material && h.lot ? lotKey(h.material, h.lot) : null,
      };
      this.holds.set(rt.id, rt);
    }
    for (const r of d.ilkNg) {
      const subjects = [r.serial, ...r.comps];
      if (!subjects.some((s) => this.units.get(s)?.status === 'HOLD')) continue;
      const main = this.units.get(r.serial);
      const lotsOf = uniq(subjects.flatMap((s) => this.units.get(s)?.lots ?? []));
      const hit = r.code === 'HOLD' ? this.holdHit(subjects, lotsOf) : null;
      this.quarantine.set(r.serial, {
        serial: r.serial, comps: r.comps, line: r.line as LineCode, station: r.station, step: r.step, code: r.code as InterlockCode, reason: r.reason,
        holdId: hit?.holdId ?? null, wo: main?.wo ?? null, variant: main?.variant ?? null, lots: lotsOf, at: r.at.toISOString(),
      });
    }
  }

  // ───────────── 개체 실적 ─────────────

  private applyUnit(u: UnitMsg): void {
    if (!LINE_CODES.has(u.line)) return;
    const line = lineOf(u.line);
    const prev = this.units.get(u.serial);
    const lots = new Set(prev?.lots ?? []);
    for (const [m, l] of Object.entries(u.lots ?? {})) lots.add(lotKey(m, l));
    for (const c of u.comps ?? []) {
      const cu = this.units.get(c);
      if (cu) {
        for (const k of cu.lots) lots.add(k);
        cu.parent = u.serial;
        cu.status = 'CONSUMED';
      } else {
        // 이력 없는 부품(초기 재공)도 상위 제품을 알아 둔다 (시리얼 Hold가 상위 제품을 찾을 수 있게)
        this.units.set(c, { line: u.line, lastStep: '', lastStation: '', lastResult: 'OK', status: 'CONSUMED', variant: null, wo: null, lots: [], parent: u.serial });
      }
    }
    const final = u.step === line.finalStep;
    const status = prev?.status === 'CONSUMED' ? 'CONSUMED' : u.result === 'NG' ? 'NG' : final ? 'DONE' : 'WIP';
    const mem: UnitMem = {
      line: u.line, lastStep: u.step, lastStation: u.station, lastResult: u.result, status,
      variant: u.variant ?? prev?.variant ?? null, wo: u.wo ?? prev?.wo ?? null, lots: [...lots], parent: prev?.parent ?? null,
    };
    this.units.set(u.serial, mem);
    // 격리에서 풀려 다시 가공됐다
    this.quarantine.delete(u.serial);

    // 작업지시 집계: 투입 공정 첫 실적 = 투입, 최종 공정 양품 = 완성
    const wo = mem.wo != null ? this.wos.get(mem.wo) : undefined;
    if (wo) {
      if (u.step === line.release && !prev) {
        wo.seen++;
        this.markWo(wo);
      }
      if (final && u.result === 'OK' && prev?.status !== 'DONE') {
        wo.doneQty++;
        this.markWo(wo);
      }
    }

    // 불량 처리
    if (u.result === 'NG' && inProductScope(line, u.step)) this.openNcr(u, mem);
    else if (u.result === 'OK' && u.reinspect) {
      const n = awaitingReinspect(this.ncrBySerial.get(u.serial));
      if (n) {
        applyReinspect(n, 'OK', u.t);
        this.saveNcr(n);
      }
    }
    if (wo) this.checkWoDone(wo, u.t);
  }

  // ───────────── 불량 처리 (NCR) ─────────────

  private indexNcr(n: NcrRt): void {
    this.ncrs.push(n);
    const list = this.ncrBySerial.get(n.serial);
    if (list) list.push(n);
    else this.ncrBySerial.set(n.serial, [n]);
  }

  private nextCode(prefix: string, existing: () => string[]): number {
    const n = (this.codeSeq.get(prefix) ?? maxSeq(existing(), prefix)) + 1;
    this.codeSeq.set(prefix, n);
    return n;
  }

  private openNcr(u: UnitMsg, mem: UnitMem): void {
    if (this.runId == null) return;
    const list = this.ncrBySerial.get(u.serial) ?? [];
    // 재검사에서 또 불합격: 앞 NCR은 재검사 NG로 종결하고, 새 NCR을 폐기로 연다
    if (u.reinspect) {
      const prev = awaitingReinspect(list);
      if (prev) {
        applyReinspect(prev, 'NG', u.t);
        this.saveNcr(prev);
      }
    }
    const defect = u.defect ?? 'UNKNOWN';
    const t = u.t;
    const n: NcrRt = {
      runId: this.runId, id: 0, code: ncrCode(t, this.nextCode(`NCR-${kstDay(t)}-`, () => this.ncrs.map((x) => x.code))),
      serial: u.serial, item: u.item, line: u.line, station: u.station, step: u.step, defect, variant: mem.variant, workOrder: mem.wo,
      status: 'OPEN', disposition: null, rule: null, decidedBy: null, decidedAt: null, repairOk: null, repairMin: null, reinspect: null,
      attempt: list.length + 1, openedAt: t, closedAt: null, note: null,
    };
    this.indexNcr(n);
    const d = initialDisposition(u.line, u.station, defect, !!u.reinspect);
    this.dispose(n, d.action, d.rule, AUTO_DECIDER, t);
  }

  /** 판정을 NCR·개체 상태·작업지시에 반영하고 시뮬레이터에 처리 명령을 보낸다 */
  private dispose(n: NcrRt, action: Disposition | 'MRB', rule: NcrState['rule'], by: string, t: string, note?: string): void {
    n.rule = rule;
    if (note) n.note = note;
    if (action === 'MRB') {
      n.status = 'WAIT_MRB';
      this.saveNcr(n);
      const waiting = this.ncrs.filter((x) => x.status === 'WAIT_MRB' && x.station === n.station).length;
      this.alarm(`mrb|${n.station}`, MRB_ALARM_MIN, n.station, 'warn', 'NCR', `${stationName(n.station)} 불량 처리 판정 대기 (MRB)`, `${n.code} · ${n.serial} · ${DEFECT_NAMES[n.defect] ?? n.defect} · 대기 ${waiting}건`);
      return;
    }
    n.disposition = action;
    n.decidedBy = by;
    n.decidedAt = t;
    n.status = statusAfter(action);
    if (n.status === 'CLOSED') n.closedAt = t;
    const us = unitStatusAfter(action);
    if (us) this.setUnitStatus(n.serial, us);
    if (action === 'SCRAP') this.addScrap(n.workOrder, t);
    this.saveNcr(n);
    this.command({ action: 'disposition', serial: n.serial, decision: action });
  }

  private applyRepair(msg: RepairMsg): void {
    const list = this.ncrBySerial.get(msg.serial);
    const n = list ? [...list].reverse().find((x) => x.status === 'REPAIRING') : undefined;
    if (!n) {
      this.logger.warn(`수리 결과에 맞는 수리 중 NCR이 없습니다: ${msg.serial}`);
      return;
    }
    const r = applyRepair(n, !!msg.ok, Number(msg.minutes) || 0, msg.t);
    this.setUnitStatus(n.serial, r.unit);
    if (r.scrapped) this.addScrap(n.workOrder, msg.t);
    this.saveNcr(n);
  }

  private saveNcr(n: NcrRt): void {
    const data = () => ({
      code: n.code, serial: n.serial, item: n.item, line: n.line, station: n.station, step: n.step, defect: n.defect, variant: n.variant, workOrder: n.workOrder,
      status: n.status, disposition: n.disposition, rule: n.rule, decidedBy: n.decidedBy, decidedAt: n.decidedAt ? new Date(n.decidedAt) : null,
      repairOk: n.repairOk, repairMin: n.repairMin, reinspect: n.reinspect, attempt: n.attempt, openedAt: new Date(n.openedAt),
      closedAt: n.closedAt ? new Date(n.closedAt) : null, note: n.note,
    });
    this.db('NCR', async () => {
      if (n.id) await this.prisma.ncr.update({ where: { id: n.id }, data: data() });
      else n.id = (await this.prisma.ncr.create({ data: { runId: n.runId, ...data() } })).id;
    });
  }

  // ───────────── 작업지시 ─────────────

  private markWo(w: WoRt): void {
    this.dirtyWo.set(w.id, w);
  }

  private addScrap(woId: number | null, t: string): void {
    const w = woId != null ? this.wos.get(woId) : undefined;
    if (!w) return;
    w.scrapQty++;
    this.markWo(w);
    this.checkWoDone(w, t);
  }

  private checkWoDone(w: WoRt, t: string): void {
    if (w.status !== 'RUNNING') return;
    if (!woDone({ ...w, released: Math.max(w.released, w.seen) })) return;
    w.status = 'DONE';
    w.endedAt = t;
    this.markWo(w);
  }

  private lineOrders(line: LineCode): WoRt[] {
    return [...this.wos.values()].filter((w) => w.line === line);
  }

  private plannedOf(line: LineCode): WoRt[] {
    return this.lineOrders(line)
      .filter((w) => w.status === 'PLANNED')
      .sort((a, b) => a.seq - b.seq);
  }

  /** 줄 세워 하나씩 (라인마다): 같은 라인의 계획 보충·작업지시 응답이 겹쳐 두 번 처리되지 않게 */
  private chain(map: Map<LineCode, Promise<void>>, line: LineCode, job: () => Promise<void>): Promise<void> {
    const next = (map.get(line) ?? Promise.resolve()).then(job).catch((e) => this.logger.error(`${line} 작업지시 처리 실패: ${(e as Error).message}`));
    map.set(line, next);
    return next;
  }

  /** 자동 계획: 대기 건이 WO_AHEAD보다 적으면 기종을 번갈아 채운다 */
  private ensurePlan(line: LineCode): Promise<void> {
    return this.chain(this.planChain, line, async () => {
      const gen = this.gen;
      if (!this.ready || this.runId == null) return;
      const orders: PlanOrder[] = this.lineOrders(line);
      for (const variant of autoFill(lineOf(line), orders)) {
        if (gen !== this.gen) return;
        await this.createWo(line, variant, WO_LOT[line], 'AUTO', null, null);
      }
    });
  }

  private async createWo(line: LineCode, variant: string, qty: number, source: WoSource, createdBy: string | null, note: string | null): Promise<WoRt> {
    const gen = this.gen;
    const runId = this.runId;
    if (runId == null) throw new BadRequestException('아직 시뮬레이터 실행이 없습니다. 시뮬레이터를 켜 주세요');
    const t = this.live.virtualNow ?? this.runStartedAt ?? new Date().toISOString();
    const seq = Math.max(0, ...this.lineOrders(line).map((w) => w.seq)) + 1;
    const prefix = woCode(line, t, 0).slice(0, -3);
    const code = woCode(line, t, this.nextCode(prefix, () => this.lineOrders(line).map((w) => w.code)));
    const row = await this.prisma.workOrder.create({ data: { runId, code, line, variant, qty, seq, status: 'PLANNED', source, createdBy, note, createdAt: new Date(t) } });
    const w: WoRt = {
      id: row.id, code, line, variant, qty, seq, status: 'PLANNED', released: 0, doneQty: 0, scrapQty: 0, source, createdBy, note,
      createdAt: t, startedAt: null, endedAt: null, seen: 0,
    };
    if (gen === this.gen) this.wos.set(w.id, w);
    return w;
  }

  private queueWoReq(msg: WoReqMsg): void {
    void this.chain(this.woChain, msg.line, () => this.handleWoReq(msg));
  }

  private async handleWoReq(msg: WoReqMsg): Promise<void> {
    const gen = this.gen;
    const line = msg.line;
    const t = this.live.virtualNow ?? msg.t;
    if (msg.finished) {
      const f = this.wos.get(msg.finished.id);
      if (f) {
        f.released = Math.max(f.released, Number(msg.finished.released) || 0);
        this.markWo(f);
        this.checkWoDone(f, t);
      }
    }
    // 내려 줬는데 아직 하나도 투입 안 한 것이 있으면 같은 것을 다시 준다 (응답을 놓쳐 다시 물은 경우)
    const lastId = this.lastDispatch.get(line);
    const last = lastId != null ? this.wos.get(lastId) : undefined;
    let next: WoRt | undefined;
    if (last && last.status === 'RUNNING' && last.id !== msg.finished?.id && last.released === 0 && last.seen === 0) {
      next = last;
    } else {
      await this.ensurePlan(line);
      if (gen !== this.gen) return;
      next = this.plannedOf(line)[0];
      if (next) {
        next.status = 'RUNNING';
        next.startedAt = t;
        this.markWo(next);
        this.lastDispatch.set(line, next.id);
      }
    }
    void this.ensurePlan(line);
    const res: WoResMsg = { t, reqId: msg.reqId, wo: next ? { id: next.id, code: next.code, variant: next.variant, qty: next.qty } : null };
    await this.mqtt.publish(TOPICS.woRes(line), res);
    if (next) this.noPlan.delete(line);
    else if (!this.noPlan.has(line)) {
      this.noPlan.add(line);
      const st = lineOf(line).stations.find((s) => s.step === lineOf(line).release)?.code ?? '';
      this.live.raiseAlarm(st, 'warn', 'WO', `${lineOf(line).name} 생산 계획 없음`, '내려 줄 대기 작업지시가 없어 투입 공정이 멈춥니다. 작업지시·계획 화면에서 만들어 주세요');
    }
  }

  // ───────────── 인터록 ─────────────

  private readonly ctx: IlkContext = {
    unit: (s) => this.units.get(s),
    hold: (serials, lots) => this.holdHit(serials, lots),
    ncr: (s) => this.ncrBySerial.get(s)?.at(-1),
    wo: (id) => this.wos.get(id),
    faPending: (station) => {
      try {
        const p = this.quality.firstArticlePending(station);
        return p ? { detail: p.detail } : null;
      } catch {
        return null;
      }
    },
  };

  /** 시리얼·LOT를 막는 Hold. 활성 Hold가 먼저, 없으면 폐기 판정으로 끝난 Hold (거부 뒤 폐기) */
  private holdHit(serials: string[], lots: string[]): HoldHit | null {
    let scrapHit: HoldHit | null = null;
    for (const h of this.holds.values()) {
      const active = h.status === 'ACTIVE';
      if (!active && h.result !== 'SCRAP') continue;
      const s = serials.find((x) => h.covers.has(x));
      const lotHit = h.lotKey != null && lots.includes(h.lotKey);
      if (!s && !lotHit) continue;
      const target = h.kind === 'LOT' ? `LOT ${h.lot}` : `시리얼 ${s}`;
      const hit: HoldHit = { holdId: h.id, holdCode: h.code, reason: `${h.code} ${target}${active ? '' : ' (폐기 판정)'} · ${h.reason}`, scrap: !active };
      if (active) return hit;
      scrapHit ??= hit;
    }
    return scrapHit;
  }

  private onIlkReq(req: IlkReqMsg): void {
    if (typeof req.reqId !== 'string' || typeof req.serial !== 'string') return;
    if (!this.ready) return this.replyIlk(req, { verdict: 'WAIT', reason: 'MES 기록 복원 중' });
    const key = `${req.station}|${req.serial}`;
    const now = Date.now();
    const since = this.routeWait.get(key);
    let d: IlkDecision;
    try {
      d = decide(req, this.ctx, since == null ? 0 : now - since);
    } catch (e) {
      this.logger.error(`인터록 판정 실패 ${req.station} ${req.serial}: ${(e as Error).message}`);
      d = { verdict: 'WAIT', reason: 'MES 판정 오류' };
    }
    if (d.verdict === 'WAIT' && d.code === 'ROUTE') {
      if (since == null) this.routeWait.set(key, now);
    } else if (since != null) this.routeWait.delete(key);
    this.replyIlk(req, d);

    const c = this.ilk.get(req.station) ?? zeroCount();
    this.ilk.set(req.station, c);
    if (d.verdict === 'OK') {
      c.ok++;
      this.waitLogged.delete(key);
      return;
    }
    if (d.verdict === 'WAIT') {
      c.wait++;
      // 같은 개체가 같은 사유로 기다리는 동안은 처음 한 번만 남긴다 (ILK_RETRY_SEC마다 다시 묻는다)
      if (this.waitLogged.get(key) === d.code) return;
      this.waitLogged.set(key, d.code ?? '');
      this.logIlk(req, d);
      return;
    }
    c.ng++;
    this.waitLogged.delete(key);
    this.logIlk(req, d);
    this.reject(req, d);
  }

  private replyIlk(req: IlkReqMsg, d: IlkDecision): void {
    const res: IlkResMsg = { t: this.live.virtualNow ?? req.t, reqId: req.reqId, serial: req.serial, verdict: d.verdict, code: d.code, reason: d.reason };
    this.mqtt.publish(TOPICS.ilkRes(req.line, req.station), res).catch((e) => this.logger.warn(`인터록 응답 실패: ${(e as Error).message}`));
  }

  private logIlk(req: IlkReqMsg, d: IlkDecision): void {
    if (this.runId == null || !d.code) return;
    this.ilkLogs.push({
      runId: this.runId, line: req.line, station: req.station, step: req.step, serial: req.serial, verdict: d.verdict, code: d.code,
      reason: d.reason ?? '', comps: req.comps ?? [], at: new Date(this.live.virtualNow ?? req.t),
    });
  }

  /** 거부: 시뮬레이터가 묶음을 격리 구역에 둔다. MES는 격리 묶음을 기억하고 개체 상태를 격리로 바꾼다 */
  private reject(req: IlkReqMsg, d: IlkDecision): void {
    const at = this.live.virtualNow ?? req.t;
    const comps = req.comps ?? [];
    const subjects = [req.serial, ...comps];
    const main = this.units.get(req.serial);
    const lots = uniq([...Object.entries(req.lots ?? {}).map(([m, l]) => lotKey(m, l)), ...subjects.flatMap((s) => this.units.get(s)?.lots ?? [])]);
    const q: QuarRt = {
      serial: req.serial, comps, line: req.line, station: req.station, step: req.step, code: d.code ?? 'ROUTE', reason: d.reason ?? '',
      holdId: d.holdId ?? null, wo: req.wo ?? main?.wo ?? null, variant: req.variant ?? main?.variant ?? null, lots, at,
    };
    this.quarantine.set(req.serial, q);
    for (const s of subjects) this.setUnitStatus(s, 'HOLD');
    this.alarm(
      `ilk|${req.station}|${q.code}`, ILK_ALARM_MIN, req.station, 'warn', 'INTERLOCK',
      `${stationName(req.station)} 투입 거부 · ${INTERLOCK_NAMES[q.code]}`, `${req.serial}: ${q.reason}`,
    );
    // 폐기 판정 Hold 대상은 격리 구역에 들어간 뒤 바로 폐기한다
    if (d.scrap) {
      const gen = this.gen;
      setTimeout(() => {
        const cur = this.quarantine.get(req.serial);
        if (gen === this.gen && cur === q) this.scrapEntries([q], this.live.virtualNow ?? at);
      }, SCRAP_DELAY_MS);
    }
  }

  private releaseEntries(entries: QuarRt[]): void {
    if (!entries.length) return;
    this.command({ action: 'release', serials: uniq(entries.flatMap((q) => [q.serial, ...q.comps])) });
    for (const q of entries) {
      this.quarantine.delete(q.serial);
      for (const s of [q.serial, ...q.comps]) if (this.units.get(s)?.status === 'HOLD') this.setUnitStatus(s, 'WIP');
    }
  }

  private scrapEntries(entries: QuarRt[], t: string): void {
    if (!entries.length) return;
    this.command({ action: 'scrap', serials: uniq(entries.flatMap((q) => [q.serial, ...q.comps])) });
    for (const q of entries) {
      this.quarantine.delete(q.serial);
      for (const s of [q.serial, ...q.comps]) this.setUnitStatus(s, 'SCRAP');
      this.addScrap(q.wo, t);
    }
  }

  // ───────────── 공용 ─────────────

  /** 개체 상태: 메모리와 production_unit (실적과 같은 큐로 순서대로). 처음 보는 시리얼(발번 전)은 건너뛴다 */
  private setUnitStatus(serial: string, status: UnitStatus): void {
    const u = this.units.get(serial);
    if (!u) return;
    if (u.status !== 'CONSUMED') u.status = status;
    this.writer.setStatus(serial, status);
  }

  private command(cmd: Parameters<MqttBrokerService['sendCommand']>[0]): void {
    this.mqtt.sendCommand(cmd).catch((e) => this.logger.warn(`시뮬레이터 명령 실패 ${cmd.action}: ${(e as Error).message}`));
  }

  /** 알람 (같은 key는 cooldownMin 가상 분에 한 번) */
  private alarm(key: string, cooldownMin: number, station: string, severity: 'info' | 'warn' | 'critical', kind: 'INTERLOCK' | 'NCR' | 'HOLD' | 'WO', title: string, detail: string): void {
    const now = Date.parse(this.live.virtualNow ?? '') || Date.now();
    const last = this.alarmAt.get(key);
    if (last != null && now - last < cooldownMin * 60_000) return;
    this.alarmAt.set(key, now);
    this.live.raiseAlarm(station, severity, kind, title, detail);
  }

  private db(label: string, op: () => Promise<unknown>): void {
    this.dbq = this.dbq.then(op).then(
      () => undefined,
      (e) => this.logger.error(`${label} 기록 실패: ${(e as Error).message}`),
    );
  }

  private flush(): void {
    if (this.dirtyWo.size) {
      const list = [...this.dirtyWo.values()];
      this.dirtyWo.clear();
      for (const w of list) {
        this.db('작업지시', () =>
          this.prisma.workOrder.update({
            where: { id: w.id },
            data: {
              qty: w.qty, seq: w.seq, status: w.status, released: Math.max(w.released, w.seen), doneQty: w.doneQty, scrapQty: w.scrapQty, note: w.note,
              startedAt: w.startedAt ? new Date(w.startedAt) : null, endedAt: w.endedAt ? new Date(w.endedAt) : null,
            },
          }),
        );
      }
    }
    if (this.ilkLogs.length) {
      const rows = this.ilkLogs;
      this.ilkLogs = [];
      this.db('인터록', () => this.prisma.interlockLog.createMany({ data: rows }));
    }
    // ROUTE 대기 기억은 1분 넘으면 버린다 (그 개체가 다른 길로 갔다)
    const old = Date.now() - 60_000;
    for (const [k, at] of this.routeWait) if (at < old) this.routeWait.delete(k);
    this.prune();
  }

  private prune(): void {
    if (this.units.size <= MAX_UNITS) return;
    let drop = this.units.size - Math.floor(MAX_UNITS * 0.8);
    for (const [s, u] of this.units) {
      if (drop <= 0) break;
      if (u.status === 'DONE' || u.status === 'SCRAP') {
        this.units.delete(s);
        drop--;
      }
    }
  }

  /** Hold 시리얼 + 이미 조립돼 들어간 상위 제품 */
  private coversOf(serials: string[]): Set<string> {
    const out = new Set<string>();
    for (const s of serials) {
      let cur: string | null = s;
      for (let i = 0; cur && i <= MAX_DEPTH; i++) {
        out.add(cur);
        cur = this.units.get(cur)?.parent ?? null;
      }
    }
    return out;
  }

  private nowIso(): string {
    return this.live.virtualNow ?? this.runStartedAt ?? new Date().toISOString();
  }

  private requireRun(): number {
    if (this.runId == null) throw new BadRequestException('아직 시뮬레이터 실행이 없습니다. 시뮬레이터를 켜 주세요');
    return this.runId;
  }

  // ───────────── 조회·조작 API: 작업지시 ─────────────

  private woView(w: WoRt, plan: WoPlanSlot | null = null): WorkOrderView {
    const released = Math.max(w.released, w.seen);
    return {
      id: w.id, code: w.code, line: w.line, variant: w.variant, qty: w.qty, seq: w.seq, status: w.status, released, doneQty: w.doneQty, scrapQty: w.scrapQty,
      wip: Math.max(0, released - w.doneQty - w.scrapQty), source: w.source, createdBy: w.createdBy, note: w.note, createdAt: w.createdAt,
      startedAt: w.startedAt, endedAt: w.endedAt, plan, releasing: this.isReleasing(w),
    };
  }

  private isReleasing(w: WoRt): boolean {
    return w.status === 'RUNNING' && this.lastDispatch.get(w.line) === w.id && Math.max(w.released, w.seen) < w.qty;
  }

  private planOf(line: LineCode): Map<number, WoPlanSlot> {
    const orders = this.lineOrders(line);
    const releasing = orders.find((w) => this.isReleasing(w));
    const lastId = this.lastDispatch.get(line);
    const lastVariant = (lastId != null ? this.wos.get(lastId)?.variant : null) ?? null;
    const now = Date.parse(this.live.virtualNow ?? '') || Date.now();
    return schedule(
      lineOf(line),
      orders.map((w) => ({ id: w.id, variant: w.variant, qty: w.qty, seq: w.seq, status: w.status, released: Math.max(w.released, w.seen), startedAt: w.startedAt })),
      now,
      releasing?.id ?? null,
      lastVariant,
    );
  }

  /** GET /orders: 진행(투입 중 먼저) → 대기(순서대로) → 지난 것(최근 끝난 것부터, 라인마다 30건) */
  orders(line?: string, status?: string): WorkOrderView[] {
    const lines = LINES.map((l) => l.code).filter((c) => !line || c === line);
    const want = status ? new Set(status.split(',').map((s) => s.trim().toUpperCase())) : null;
    const out: WorkOrderView[] = [];
    for (const code of lines) {
      const plan = this.planOf(code);
      const all = this.lineOrders(code);
      const running = all.filter((w) => w.status === 'RUNNING').sort((a, b) => Number(this.isReleasing(b)) - Number(this.isReleasing(a)) || a.seq - b.seq);
      const planned = all.filter((w) => w.status === 'PLANNED').sort((a, b) => a.seq - b.seq);
      const past = all
        .filter((w) => w.status === 'DONE' || w.status === 'CANCELLED')
        .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || b.seq - a.seq)
        .slice(0, HISTORY_PER_LINE);
      for (const w of [...running, ...planned, ...past]) if (!want || want.has(w.status)) out.push(this.woView(w, plan.get(w.id) ?? null));
    }
    return out;
  }

  private checkNote(v: unknown, label = '메모'): string | null {
    if (v == null) return null;
    if (typeof v !== 'string') throw new BadRequestException(`${label}는 글자여야 합니다`);
    const s = v.trim();
    if (s.length > EXEC_NOTE_MAX) throw new BadRequestException(`${label}는 ${EXEC_NOTE_MAX}자까지입니다`);
    return s || null;
  }

  private checkQty(v: unknown): number {
    const q = Number(v);
    if (!Number.isInteger(q) || q < 1 || q > WO_QTY_MAX) throw new BadRequestException(`수량은 1 ~ ${WO_QTY_MAX} 사이 정수입니다`);
    return q;
  }

  private getWo(id: number): WoRt {
    const w = this.wos.get(id);
    if (!w) throw new NotFoundException(`작업지시 #${id}이(가) 지금 실행에 없습니다`);
    return w;
  }

  async createOrder(body: WorkOrderCreate, who: ActorInfo, ip?: string): Promise<WorkOrderView> {
    this.requireRun();
    if (!LINE_CODES.has(body?.line)) throw new BadRequestException('라인을 골라 주세요');
    const line = lineOf(body.line);
    if (!line.variants.some((v) => v.code === body.variant)) throw new BadRequestException(`${line.name}에 없는 기종입니다: ${body.variant}`);
    const qty = this.checkQty(body.qty);
    const note = this.checkNote(body.note);
    const w = await this.createWo(line.code, body.variant, qty, 'USER', who.name, note);
    void this.audit.log(who, 'wo.create', w.code, { line: w.line, variant: w.variant, qty, note }, ip);
    return this.woView(w);
  }

  updateOrder(id: number, body: WorkOrderPatch, who: ActorInfo, ip?: string): WorkOrderView {
    const w = this.getWo(id);
    if (w.status === 'DONE' || w.status === 'CANCELLED') throw new ConflictException(`${w.code}은(는) 이미 끝난 작업지시입니다`);
    const detail: Record<string, unknown> = {};
    if (body?.qty != null) {
      if (w.status !== 'PLANNED') throw new ConflictException('투입이 시작된 작업지시의 수량은 바꿀 수 없습니다. 중단하고 새로 만들어 주세요');
      detail.qty = { from: w.qty, to: (w.qty = this.checkQty(body.qty)) };
    }
    if (body && 'note' in body) detail.note = w.note = this.checkNote(body.note);
    this.markWo(w);
    void this.audit.log(who, 'wo.update', w.code, detail, ip);
    return this.woView(w);
  }

  async cancelOrder(id: number, who: ActorInfo, ip?: string): Promise<WorkOrderView> {
    const w = this.getWo(id);
    if (w.status === 'DONE' || w.status === 'CANCELLED') throw new ConflictException(`${w.code}은(는) 이미 끝난 작업지시입니다`);
    const wasRunning = w.status === 'RUNNING';
    w.status = 'CANCELLED';
    w.endedAt = this.nowIso();
    this.markWo(w);
    // 투입 중이면 시뮬레이터가 그 작업지시 투입을 멈추고 다음을 요청한다
    if (wasRunning) await this.mqtt.sendCommand({ action: 'wo-cancel', line: w.line, id: w.id }).catch((e) => this.logger.warn(`작업지시 중단 명령 실패: ${(e as Error).message}`));
    void this.ensurePlan(w.line);
    void this.audit.log(who, 'wo.cancel', w.code, { line: w.line, status: wasRunning ? 'RUNNING' : 'PLANNED', released: Math.max(w.released, w.seen) }, ip);
    return this.woView(w);
  }

  reorderOrders(body: WorkOrderReorder, who: ActorInfo, ip?: string): WorkOrderView[] {
    if (!LINE_CODES.has(body?.line)) throw new BadRequestException('라인을 골라 주세요');
    if (!Array.isArray(body.ids) || body.ids.some((x) => !Number.isInteger(x))) throw new BadRequestException('작업지시 번호 목록이 필요합니다');
    const planned = this.plannedOf(body.line);
    const seqs = reorder(planned, body.ids);
    for (const w of planned) {
      const s = seqs.get(w.id);
      if (s != null && s !== w.seq) {
        w.seq = s;
        this.markWo(w);
      }
    }
    void this.audit.log(who, 'wo.reorder', body.line, { order: this.plannedOf(body.line).map((w) => w.code) }, ip);
    return this.orders(body.line, 'PLANNED');
  }

  // ───────────── 조회·조작 API: NCR ─────────────

  private ncrView(n: NcrRt): NcrView {
    return {
      id: n.id, code: n.code, serial: n.serial, item: n.item, line: n.line, station: n.station, step: n.step, defect: n.defect, variant: n.variant,
      workOrder: n.workOrder, woCode: n.workOrder != null ? (this.wos.get(n.workOrder)?.code ?? null) : null, status: n.status, disposition: n.disposition,
      rule: n.rule, decidedBy: n.decidedBy, decidedAt: n.decidedAt, repairOk: n.repairOk, repairMin: n.repairMin, reinspect: n.reinspect,
      attempt: n.attempt, openedAt: n.openedAt, closedAt: n.closedAt, note: n.note, outcome: outcome(n),
    };
  }

  /** GET /ncr: status = 상태 하나 또는 ACTIVE(종결 전 전부). 요약은 라인 조건만 적용한다 */
  ncrList(status?: string, line?: string): NcrList {
    const inLine = this.ncrs.filter((n) => !line || n.line === line);
    const st = status?.toUpperCase();
    const items = inLine
      .filter((n) => n.id > 0 && (!st || (st === 'ACTIVE' ? n.status !== 'CLOSED' : n.status === st)))
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.id - a.id)
      .slice(0, NCR_LIST_MAX)
      .map((n) => this.ncrView(n));
    return { items, summary: summarize(inLine) };
  }

  private getNcr(id: number): NcrRt {
    const n = this.ncrs.find((x) => x.id === id);
    if (!n) throw new NotFoundException(`NCR #${id}이(가) 지금 실행에 없습니다`);
    return n;
  }

  ncrDetail(id: number): NcrDetail {
    const n = this.getNcr(id);
    const d = defaultDisposition(n.line, n.station, n.defect);
    return {
      ...this.ncrView(n),
      history: (this.ncrBySerial.get(n.serial) ?? []).filter((x) => x !== n).map((x) => this.ncrView(x)),
      suggested: { action: d.action, rule: d.rule, minutes: d.minutes, prob: d.prob },
    };
  }

  disposeNcr(id: number, body: NcrDisposeInput, who: ActorInfo, ip?: string): NcrView {
    const n = this.getNcr(id);
    const decision = body?.decision;
    if (!['REPAIR', 'REWORK', 'SCRAP', 'UAI'].includes(decision)) throw new BadRequestException('판정은 수리·재작업·폐기·특채 중 하나입니다');
    if (!canDispose(n.status)) throw new ConflictException(`${n.code}은(는) 이미 판정됐습니다 (${n.status})`);
    const note = this.checkNote(body.note);
    if (decision === 'UAI' && !note) throw new BadRequestException('특채는 근거를 메모로 남겨 주세요');
    this.dispose(n, decision, 'manual', who.name, this.nowIso(), note ?? undefined);
    void this.audit.log(who, 'ncr.dispose', n.code, { serial: n.serial, defect: n.defect, decision, note }, ip);
    return this.ncrView(n);
  }

  // ───────────── 조회·조작 API: Hold ─────────────

  private covered(h: HoldRt, q: QuarRt): boolean {
    return q.holdId === h.id || [q.serial, ...q.comps].some((s) => h.covers.has(s)) || (h.lotKey != null && q.lots.includes(h.lotKey));
  }

  private holdView(h: HoldRt): HoldView {
    return {
      id: h.id, code: h.code, kind: h.kind, material: h.material, lot: h.lot, serials: h.serials, reason: h.reason, status: h.status,
      createdBy: h.createdBy, createdAt: h.createdAt, releasedBy: h.releasedBy, releasedAt: h.releasedAt, releaseNote: h.releaseNote, result: h.result,
      quarantined: h.status === 'ACTIVE' ? [...this.quarantine.values()].filter((q) => this.covered(h, q)).map((q) => q.serial) : [],
    };
  }

  private quarView(q: QuarRt): QuarantineView {
    return {
      serial: q.serial, comps: q.comps, line: q.line, station: q.station, step: q.step, code: q.code, reason: q.reason, holdId: q.holdId,
      holdCode: q.holdId != null ? (this.holds.get(q.holdId)?.code ?? null) : null, wo: q.wo, variant: q.variant, at: q.at,
    };
  }

  /** GET /holds: 활성 먼저(최근부터), 그다음 해제된 것 */
  holdList(status?: string): HoldList {
    const st = status?.toUpperCase();
    const holds = [...this.holds.values()]
      .filter((h) => !st || h.status === st)
      .sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || b.id - a.id)
      .map((h) => this.holdView(h));
    const quarantine = [...this.quarantine.values()].sort((a, b) => b.at.localeCompare(a.at)).map((q) => this.quarView(q));
    return { holds, quarantine };
  }

  private getHold(id: number): HoldRt {
    const h = this.holds.get(id);
    if (!h) throw new NotFoundException(`Hold #${id}이(가) 지금 실행에 없습니다`);
    return h;
  }

  async holdDetail(id: number): Promise<HoldDetail> {
    const h = this.getHold(id);
    return { ...this.holdView(h), impact: await this.impact(h) };
  }

  /** 영향 범위: 대상 개체(LOT를 쓴 부품 또는 Hold 시리얼) → 조립된 맨 위 제품 (parent_serial을 따라 올라간다) */
  private async impact(h: HoldRt): Promise<HoldImpact> {
    const runId = this.requireRun();
    const base =
      h.kind === 'LOT'
        ? Prisma.sql`SELECT DISTINCT serial FROM material_lot_use WHERE run_id = ${runId} AND material = ${h.material} AND lot = ${h.lot}`
        : Prisma.sql`SELECT DISTINCT s AS serial FROM unnest(${h.serials}::text[]) AS s`;
    const rows = await this.prisma.$queryRaw<{ top: string; item: string | null; line: string | null; status: string | null; defect: string | null; parts: number; last_at: Date | null }[]>(Prisma.sql`
      WITH RECURSIVE base AS (${base}),
      chain AS (
        SELECT b.serial AS base, b.serial AS cur, 0 AS depth FROM base b
        UNION ALL
        SELECT c.base, u.parent_serial, c.depth + 1
        FROM chain c JOIN production_unit u ON u.run_id = ${runId} AND u.serial = c.cur
        WHERE u.parent_serial IS NOT NULL AND c.depth < ${MAX_DEPTH}::int
      ),
      top AS (SELECT DISTINCT ON (base) base, cur AS top FROM chain ORDER BY base, depth DESC)
      SELECT t.top, u.item, u.line, u.status, u.defect, count(*)::int AS parts, u.last_at
      FROM top t LEFT JOIN production_unit u ON u.run_id = ${runId} AND u.serial = t.top
      GROUP BY t.top, u.item, u.line, u.status, u.defect, u.last_at
      ORDER BY u.last_at DESC NULLS LAST
      LIMIT ${IMPACT_MAX}::int`);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status ?? 'NONE'] = (byStatus[r.status ?? 'NONE'] ?? 0) + 1;
    const inProcess = ['WIP', 'HOLD', 'REPAIR', 'NG'].reduce((a, s) => a + (byStatus[s] ?? 0), 0);
    return {
      base: rows.reduce((a, r) => a + r.parts, 0),
      byStatus,
      finished: byStatus.DONE ?? 0,
      inProcess,
      tops: rows.slice(0, IMPACT_TOPS).map((r) => ({ serial: r.top, item: r.item, line: r.line, status: r.status, defect: r.defect, parts: r.parts, lastAt: r.last_at?.toISOString() ?? null })),
      truncated: rows.length > IMPACT_TOPS || rows.length >= IMPACT_MAX,
    };
  }

  async createHold(body: HoldCreate, who: ActorInfo, ip?: string): Promise<HoldView> {
    const runId = this.requireRun();
    const reason = this.checkNote(body?.reason, '사유');
    if (!reason) throw new BadRequestException('Hold 사유를 적어 주세요');
    let material: string | null = null;
    let lot: string | null = null;
    let serials: string[] = [];
    if (body.kind === 'LOT') {
      material = String(body.material ?? '').trim().toUpperCase();
      lot = String(body.lot ?? '').trim().toUpperCase();
      if (!FACTORY.materials.some((m) => m.code === material)) throw new BadRequestException(`자재 코드가 없습니다: ${material || '(빈칸)'}`);
      if (!/^[A-Z0-9_-]{3,60}$/.test(lot)) throw new BadRequestException('LOT 번호를 확인해 주세요');
      const dup = [...this.holds.values()].find((h) => h.status === 'ACTIVE' && h.lotKey === lotKey(material!, lot!));
      if (dup) throw new ConflictException(`이미 활성 Hold가 있습니다: ${dup.code}`);
    } else if (body.kind === 'SERIAL') {
      serials = uniq((Array.isArray(body.serials) ? body.serials : []).map((s) => String(s).trim().toUpperCase()).filter(Boolean));
      if (!serials.length) throw new BadRequestException('Hold할 시리얼을 넣어 주세요');
      if (serials.length > HOLD_SERIALS_MAX) throw new BadRequestException(`시리얼은 한 번에 ${HOLD_SERIALS_MAX}개까지입니다`);
      const bad = serials.find((s) => !/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(s));
      if (bad) throw new BadRequestException(`시리얼 형식이 아닙니다: ${bad}`);
    } else throw new BadRequestException('Hold 종류는 LOT 또는 SERIAL입니다');

    const t = this.nowIso();
    const code = holdCode(t, this.nextCode(`HOLD-${kstDay(t)}-`, () => [...this.holds.values()].map((h) => h.code)));
    const row = await this.prisma.hold.create({
      data: { runId, code, kind: body.kind, material, lot, serials, reason, status: 'ACTIVE', createdBy: who.name, createdAt: new Date(t) },
    });
    const h: HoldRt = {
      id: row.id, code, kind: body.kind, material, lot, serials, reason, status: 'ACTIVE', createdBy: who.name, createdAt: t,
      releasedBy: null, releasedAt: null, releaseNote: null, result: null, covers: this.coversOf(serials), lotKey: material && lot ? lotKey(material, lot) : null,
    };
    if (runId === this.runId) this.holds.set(h.id, h);
    // 격리 구역에 이미 있는 묶음 중 이 Hold 대상은 이 Hold로 묶는다 (다른 사유로 걸린 것도 해제·폐기를 여기서 한다)
    for (const q of this.quarantine.values()) if (q.holdId == null && this.covered(h, q)) q.holdId = h.id;
    if (h.kind === 'LOT') this.command({ action: 'lot-hold', material: material!, lot: lot! });
    const target = h.kind === 'LOT' ? `${material} LOT ${lot}` : `${serials.slice(0, 3).join(', ')}${serials.length > 3 ? ` 외 ${serials.length - 3}개` : ''}`;
    const station = h.kind === 'LOT' ? (MATERIAL_STATION[material!] ?? '') : (this.units.get(serials[0])?.lastStation ?? '');
    this.live.raiseAlarm(station, 'warn', 'HOLD', `Hold 설정 ${code} · ${HOLD_KIND_NAMES[h.kind]}`, `${target} · ${reason} (${who.name})`);
    void this.audit.log(who, 'hold.create', code, { kind: h.kind, material, lot, serials, reason }, ip);
    return this.holdView(h);
  }

  async releaseHold(id: number, body: HoldReleaseInput, who: ActorInfo, ip?: string): Promise<HoldView> {
    const h = this.getHold(id);
    if (h.status !== 'ACTIVE') throw new ConflictException(`${h.code}은(는) 이미 해제됐습니다`);
    const result = body?.result;
    if (result !== 'RELEASE' && result !== 'SCRAP') throw new BadRequestException('판정은 RELEASE(해제) 또는 SCRAP(폐기)입니다');
    const note = this.checkNote(body.note);
    if (!note) throw new BadRequestException('해제 메모를 적어 주세요 (판정 근거)');
    const entries = [...this.quarantine.values()].filter((q) => this.covered(h, q));
    const t = this.nowIso();
    h.status = 'RELEASED';
    h.result = result;
    h.releasedBy = who.name;
    h.releasedAt = t;
    h.releaseNote = note;
    await this.prisma.hold.update({ where: { id: h.id }, data: { status: h.status, result, releasedBy: who.name, releasedAt: new Date(t), releaseNote: note } });
    let released = 0;
    let scrapped = 0;
    if (result === 'RELEASE') {
      const free: QuarRt[] = [];
      const scrap: QuarRt[] = [];
      for (const q of entries) {
        // 다른 활성 Hold가 아직 걸고 있으면 남긴다
        const still = this.holdHit([q.serial, ...q.comps], q.lots);
        if (still && !still.scrap) q.holdId = still.holdId;
        else if (still?.scrap) scrap.push(q);
        else free.push(q);
      }
      this.releaseEntries(free);
      this.scrapEntries(scrap, t);
      released = free.length;
      scrapped = scrap.length;
    } else {
      // 격리 구역에 있는 대상은 바로 폐기. 아직 공정 안에 있는 대상은 다음 게이트에서 걸러 폐기한다 (holdHit의 폐기 판정)
      this.scrapEntries(entries, t);
      scrapped = entries.length;
    }
    void this.audit.log(who, 'hold.release', h.code, { result, note, released, scrapped }, ip);
    return this.holdView(h);
  }

  // ───────────── 조회 API: 인터록·요약 ─────────────

  async interlock(line?: string, station?: string): Promise<InterlockReport> {
    const runId = this.runId ?? this.writer.currentRunId;
    const stations = Object.values(STATIONS).filter((s) => s.gate && (!line || s.line === line) && (!station || s.code === station));
    const live = zeroCount();
    for (const s of stations) {
      const c = this.ilk.get(s.code);
      if (c) {
        live.ok += c.ok;
        live.ng += c.ng;
        live.wait += c.wait;
      }
    }
    if (runId == null) return { recent: [], stats: { live: { ...live, since: this.ilkSince }, byCode: [], byStation: [], skipped: 0 } };
    const where = { runId, ...(line ? { line } : {}), ...(station ? { station } : {}) };
    const [recent, byCode, byStation, skipped] = await Promise.all([
      this.prisma.interlockLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: ILK_RECENT }),
      this.prisma.interlockLog.groupBy({ by: ['code', 'verdict'], where, _count: { _all: true } }),
      this.prisma.interlockLog.groupBy({ by: ['station', 'verdict'], where, _count: { _all: true } }),
      this.prisma.processRecord.count({ where: { ...where, ilkSkip: true } }),
    ]);
    const codes = new Map<InterlockCode, { ng: number; wait: number }>();
    for (const r of byCode) {
      const c = codes.get(r.code as InterlockCode) ?? { ng: 0, wait: 0 };
      if (r.verdict === 'NG') c.ng += r._count._all;
      else c.wait += r._count._all;
      codes.set(r.code as InterlockCode, c);
    }
    const st = new Map<string, InterlockCount>(stations.map((s) => [s.code, { ok: this.ilk.get(s.code)?.ok ?? 0, ng: 0, wait: 0 }]));
    for (const r of byStation) {
      const c = st.get(r.station) ?? zeroCount();
      if (r.verdict === 'NG') c.ng += r._count._all;
      else c.wait += r._count._all;
      st.set(r.station, c);
    }
    return {
      recent: recent.map((r) => ({
        id: Number(r.id), line: r.line as LineCode, station: r.station, step: r.step, serial: r.serial, verdict: r.verdict as 'NG' | 'WAIT',
        code: r.code as InterlockCode, reason: r.reason, comps: r.comps, at: r.at.toISOString(),
      })),
      stats: {
        live: { ...live, since: this.ilkSince },
        byCode: [...codes].map(([code, c]) => ({ code, ...c })).sort((a, b) => b.ng - a.ng || b.wait - a.wait),
        byStation: [...st].map(([s, c]) => ({ station: s, ...c })),
        skipped,
      },
    };
  }

  summary(): ExecutionSummary {
    const lines: LineExecution[] = LINES.map((l) => {
      const plan = this.planOf(l.code);
      const all = this.lineOrders(l.code);
      const running = all.filter((w) => w.status === 'RUNNING').sort((a, b) => a.seq - b.seq);
      const releasing = running.find((w) => this.isReleasing(w));
      const lastId = this.lastDispatch.get(l.code);
      const current = releasing ?? running.find((w) => w.id === lastId) ?? null;
      const planned = this.plannedOf(l.code);
      const ncr = this.ncrs.filter((n) => n.line === l.code);
      const ilk = zeroCount();
      for (const s of l.stations) {
        const c = this.ilk.get(s.code);
        if (c) {
          ilk.ok += c.ok;
          ilk.ng += c.ng;
          ilk.wait += c.wait;
        }
      }
      return {
        line: l.code,
        current: current ? this.woView(current, plan.get(current.id) ?? null) : null,
        running: running.map((w) => this.woView(w, plan.get(w.id) ?? null)),
        planned: planned.length,
        next: planned[0] ? this.woView(planned[0], plan.get(planned[0].id) ?? null) : null,
        ncrOpen: ncr.filter((n) => n.status !== 'CLOSED').length,
        waitMrb: ncr.filter((n) => n.status === 'WAIT_MRB').length,
        repairing: ncr.filter((n) => n.status === 'REPAIRING' || n.status === 'REINSPECT').length,
        quarantine: [...this.quarantine.values()].filter((q) => q.line === l.code).length,
        ilk,
      };
    });
    return { t: this.live.virtualNow, ready: this.ready, lines, holdsActive: [...this.holds.values()].filter((h) => h.status === 'ACTIVE').length };
  }
}
