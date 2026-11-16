import { randomInt } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  EXEC_NOTE_MAX,
  LINES,
  WHATIF_LIMITS,
  type ActorInfo,
  type LineCode,
  type WhatIfApplyResult,
  type WhatIfBase,
  type WhatIfBaseSource,
  type WhatIfOrder,
  type WhatIfRequest,
  type WhatIfResult,
  type WhatIfRunSummary,
  type WhatIfRunView,
  type WhatIfSimInput,
  type WhatIfStatus,
} from '@lumitwin/shared';
import { ExecutionService } from '../execution/execution.service';
import { Prisma } from '../generated/prisma/client';
import { HealthService } from '../insights/health.service';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from '../production/production.writer';
import { aggregate } from './aggregate';
import { buildBase } from './base';
import { normalizeRequest, parseSource, type SimScenario } from './validate';
import { defaultRunner, workerCount, type SimRunner } from './whatif.runner';

/** 줄 서서 기다릴 수 있는 계산 수 (돌고 있는 것 제외). 계산이 무거워 너무 쌓이지 않게 (assumed) */
const MAX_WAITING = 5;
/** 진행률을 DB에 쓰는 최소 간격 (실제 ms). 화면은 메모리 값을 먼저 본다 */
const PROGRESS_WRITE_MS = 1_000;
const LIST_MAX = 50;
const ERROR_MAX = 4000;
export const RESTART_MESSAGE = '서버가 다시 시작돼 계산이 끊겼습니다';

type Row = Awaited<ReturnType<PrismaService['whatIfRun']['findFirstOrThrow']>>;

interface Job {
  id: number;
  input: WhatIfSimInput;
  request: WhatIfRequest;
  base: WhatIfBase;
  sim: SimScenario[];
}

const LINE_CODES = new Set<string>(LINES.map((l) => l.code));
const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * What-if 계획 시뮬레이션 (P11).
 * 요청을 검사하고 지금 공장 상태(기준 상태)를 만들어 저장(QUEUED)한 뒤 뒤에서 시뮬레이터를 돌린다 (한 번에 1건).
 * 화면은 GET /whatif/runs/:id를 다시 읽어 진행률·결과를 본다. 결과 KPI는 라이브 화면과 같은 함수로 집계한다
 */
@Injectable()
export class WhatIfService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WhatIf');
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;
  private progress = new Map<number, { done: number; total: number }>();
  private readonly stop = new AbortController();
  private runner: SimRunner = defaultRunner;
  /** 같은 계획을 두 번 눌러 겹쳐 반영하지 않게 */
  private applying = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly exec: ExecutionService,
    private readonly health: HealthService,
    private readonly writer: ProductionWriter,
  ) {}

  async onModuleInit(): Promise<void> {
    // 계산 중에 서버가 꺼졌던 실행은 이어 할 수 없다 (자식 프로세스와 함께 끊겼다)
    try {
      const n = await this.prisma.whatIfRun.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', error: RESTART_MESSAGE } });
      if (n.count) this.log.warn(`계산 중이던 What-if ${n.count}건을 실패로 표시 (서버 재시작)`);
    } catch (e) {
      this.log.warn(`What-if 기록 정리 실패: ${(e as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  /** 시험용: 실행기를 바꾼다 */
  useRunner(runner: SimRunner): void {
    this.runner = runner;
  }

  /** 시험용: 줄 선 계산이 다 끝날 때까지 */
  idle(): Promise<void> {
    return this.chain;
  }

  // ───────────── 기준 상태 ─────────────

  makeBase(source: WhatIfBaseSource): WhatIfBase {
    const snap = this.live.snapshot();
    let vib: Record<string, number | null> = {};
    try {
      vib = Object.fromEntries(this.health.view().stations.map((s) => [s.station, s.vib]));
    } catch {
      vib = {};
    }
    return buildBase({
      source,
      sim: snap.connected?.sim ? snap.sim : null,
      stations: snap.stations,
      vib,
      orders: this.exec.orders(undefined, 'RUNNING,PLANNED'),
      amrs: snap.amrs,
      virtualNow: this.live.virtualNow,
      nowMs: Date.now(),
    });
  }

  /** GET /whatif/base: 편집 화면이 작업지시·설비·시나리오 목록을 여기서 얻는다 */
  preview(source?: string): WhatIfBase {
    return this.makeBase(parseSource(source || 'live'));
  }

  // ───────────── 계산 ─────────────

  async create(body: unknown, who: ActorInfo): Promise<WhatIfRunView> {
    if (this.waiting >= MAX_WAITING) throw new ConflictException(`계산 대기열이 가득 찼습니다 (최대 ${MAX_WAITING}건). 앞 계산이 끝난 뒤 다시 돌려 주세요`);
    const { request, base, sim } = normalizeRequest(body, (src) => this.makeBase(src));
    const seed = randomInt(1, 1_000_000);
    const total = request.scenarios.length * request.reps;
    const row = await this.prisma.whatIfRun.create({
      data: {
        runId: this.writer.currentRunId,
        createdBy: who.name,
        status: 'QUEUED',
        horizonH: request.horizonH,
        reps: request.reps,
        seed,
        request: json(request),
        base: json(base),
        progressDone: 0,
        progressTotal: total,
        vStartAt: new Date(base.startAt),
      },
    });
    const input: WhatIfSimInput = { horizonSec: Math.round(request.horizonH * 3600), reps: request.reps, seed, workers: workerCount(), base, scenarios: sim };
    const job: Job = { id: row.id, input, request, base, sim };
    this.progress.set(row.id, { done: 0, total });
    this.waiting++;
    this.chain = this.chain
      .then(() => {
        this.waiting--;
        return this.process(job);
      })
      .catch((e) => this.log.error(`What-if #${job.id} 처리 실패: ${(e as Error).message}`));
    return this.view(row);
  }

  private async process(job: Job): Promise<void> {
    const t0 = Date.now();
    let writes: Promise<unknown> = Promise.resolve();
    let lastWrite = 0;
    try {
      await this.prisma.whatIfRun.update({ where: { id: job.id }, data: { status: 'RUNNING' } });
      const runs = await this.runner(job.input, {
        timeoutMs: WHATIF_LIMITS.timeoutSec * 1000,
        signal: this.stop.signal,
        onProgress: (done, total) => {
          this.progress.set(job.id, { done, total });
          const now = Date.now();
          if (now - lastWrite < PROGRESS_WRITE_MS) return;
          lastWrite = now;
          writes = writes.then(() => this.prisma.whatIfRun.update({ where: { id: job.id }, data: { progressDone: done, progressTotal: total } })).catch(() => undefined);
        },
      });
      const result = aggregate({ request: job.request, base: job.base, sim: job.sim, seed: job.input.seed, runs, elapsedMs: Date.now() - t0 });
      await writes;
      const total = this.progress.get(job.id)?.total ?? job.request.scenarios.length * job.request.reps;
      await this.prisma.whatIfRun.update({
        where: { id: job.id },
        data: { status: 'DONE', result: json(result), progressDone: total, progressTotal: total, elapsedMs: result.elapsedMs },
      });
      this.log.log(`What-if #${job.id} 완료: 계획 ${job.request.scenarios.length}개 × 반복 ${job.request.reps}번 · ${result.elapsedMs}ms`);
    } catch (e) {
      const msg = ((e as Error).message || '알 수 없는 오류').slice(0, ERROR_MAX);
      await writes;
      await this.prisma.whatIfRun
        .update({ where: { id: job.id }, data: { status: 'FAILED', error: msg, elapsedMs: Date.now() - t0 } })
        .catch((x) => this.log.error(`What-if #${job.id} 실패 기록 실패: ${(x as Error).message}`));
      this.log.warn(`What-if #${job.id} 실패: ${msg.split('\n')[0]}`);
    } finally {
      this.progress.delete(job.id);
    }
  }

  // ───────────── 조회 ─────────────

  private view(row: Row): WhatIfRunView {
    return {
      id: row.id,
      status: row.status as WhatIfStatus,
      progress: this.progress.get(row.id) ?? { done: row.progressDone, total: row.progressTotal },
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
      vStartAt: row.vStartAt.toISOString(),
      request: row.request as unknown as WhatIfRequest,
      base: row.base as unknown as WhatIfBase,
      result: (row.result as unknown as WhatIfResult | null) ?? null,
      error: row.error,
    };
  }

  private summary(row: Row): WhatIfRunSummary {
    const { base: _b, result, ...rest } = this.view(row);
    return { ...rest, outMeans: result ? result.scenarios.map((s) => s.total.out.mean) : null };
  }

  async list(limit = 10): Promise<WhatIfRunSummary[]> {
    const take = Math.min(LIST_MAX, Math.max(1, Number.isInteger(limit) ? limit : 10));
    const rows = await this.prisma.whatIfRun.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take });
    return rows.map((r) => this.summary(r));
  }

  private async row(id: number): Promise<Row> {
    const row = await this.prisma.whatIfRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`What-if 계산 #${id}이(가) 없습니다`);
    return row;
  }

  async detail(id: number): Promise<WhatIfRunView> {
    return this.view(await this.row(id));
  }

  /** AI 비서: 가장 최근 완료된 계산(또는 고른 것)과 그 뒤에 줄 선·계산 중인 것 */
  async latestForAssistant(id?: number): Promise<{ view: WhatIfRunView | null; pending: { id: number; status: WhatIfStatus; progress: { done: number; total: number } } | null }> {
    const done = id != null ? await this.prisma.whatIfRun.findUnique({ where: { id } }) : await this.prisma.whatIfRun.findFirst({ where: { status: 'DONE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (id != null && !done) throw new NotFoundException(`What-if 계산 #${id}이(가) 없습니다`);
    const next = await this.prisma.whatIfRun.findFirst({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const pending = next ? { id: next.id, status: next.status as WhatIfStatus, progress: this.progress.get(next.id) ?? { done: next.progressDone, total: next.progressTotal } } : null;
    return { view: done ? this.view(done) : null, pending };
  }

  // ───────────── MES 반영 ─────────────

  /**
   * 계획 하나의 라인 작업지시 순서를 MES 대기 순서에 반영한다.
   * 기존 대기 지시는 실행 모듈의 순서 바꾸기로, 계획에서 새로 더한 지시는 작업지시를 만든 뒤 그 자리로 옮긴다.
   * 계획에서 빠진 대기 지시는 중단하지 않고 뒤에 남긴다(untouched). 투입 중·이미 시작된 지시는 건드리지 않는다.
   * 만든 지시의 메모에 계산 번호를 남겨, 다시 눌러도 같은 지시를 또 만들지 않는다
   */
  async apply(id: number, body: unknown, who: ActorInfo, ip?: string): Promise<WhatIfApplyResult & { scenarioName: string }> {
    const row = await this.row(id);
    if (row.status !== 'DONE') throw new ConflictException('계산이 끝난 What-if만 MES에 반영할 수 있습니다');
    if (row.runId == null || row.runId !== this.writer.currentRunId) {
      throw new ConflictException('계산한 뒤 시뮬레이터 실행이 바뀌어 반영할 수 없습니다. 지금 상태로 다시 계산해 주세요');
    }
    const req = row.request as unknown as WhatIfRequest;
    const base = row.base as unknown as WhatIfBase;
    const b = (body ?? {}) as { scenario?: unknown; line?: unknown };
    const si = b.scenario;
    if (!Number.isInteger(si) || (si as number) < 0 || (si as number) >= req.scenarios.length) throw new BadRequestException(`계획 번호(scenario)는 0 ~ ${req.scenarios.length - 1}입니다`);
    if (typeof b.line !== 'string' || !LINE_CODES.has(b.line)) throw new BadRequestException('라인(HL·EM·OSM)을 골라 주세요');
    const line = b.line as LineCode;
    const sc = req.scenarios[si as number];
    const plan: WhatIfOrder[] = sc.orders?.[line] ?? (base.lines[line]?.orders ?? []).map((o) => ({ id: o.id, code: o.code, variant: o.variant, qty: o.qty }));

    const key = `${id}:${si as number}:${line}`;
    if (this.applying.has(key)) throw new ConflictException('이 계획을 반영하는 중입니다');
    this.applying.add(key);
    try {
      const before = new Map(this.exec.orders(line, 'PLANNED').map((w) => [w.id, w.seq]));
      const all = this.exec.orders(line);
      const ids: number[] = [];
      const created: number[] = [];
      let n = 0;
      for (const o of plan) {
        if (o.id != null) {
          if (before.has(o.id)) ids.push(o.id); // 투입 중이거나 그 사이 시작·끝난 지시는 건너뛴다
          continue;
        }
        n++;
        const note = `What-if #${id} 계획 ${(si as number) + 1} '${sc.name}' 새 지시 ${n} (${o.code ?? `NEW-${line}-${n}`})`.slice(0, EXEC_NOTE_MAX);
        const prev = all.find((w) => w.note === note);
        if (prev) {
          if (prev.status === 'PLANNED') ids.push(prev.id);
          continue;
        }
        const w = await this.exec.createOrder({ line, variant: o.variant, qty: o.qty, note }, who, ip);
        created.push(w.id);
        ids.push(w.id);
      }
      const after = new Map(this.exec.reorderOrders({ line, ids }, who, ip).map((w) => [w.id, w.seq]));
      const picked = new Set(ids);
      const reordered = ids.filter((x) => before.has(x) && after.has(x) && after.get(x) !== before.get(x));
      const untouched = [...before.keys()].filter((x) => !picked.has(x));
      return { line, reordered, created, untouched, scenarioName: sc.name };
    } finally {
      this.applying.delete(key);
    }
  }
}
