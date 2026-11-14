import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATIONS, faRequired, type AlarmLive, type ActorInfo, type ChangeMsg, type InspMsg, type SimCommand, type SimStatusMsg } from '@lumitwin/shared';
import type { LiveService } from '../src/live/live.service';
import type { MqttBrokerService, MqttInbound } from '../src/mqtt/mqtt-broker.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { ProductionWriter } from '../src/production/production.writer';
import { FaLedger, approveBlockReason, clampLimit, parseChangeRequest, parseTime } from '../src/quality-system/quality-system.logic';
import { QualitySystemService } from '../src/quality-system/quality-system.service';

const GATE = 'HL-SL-01'; // 인터록 게이트 · 초물 대상
const START = '2026-11-13T00:00:00.000Z';
const at = (min: number) => new Date(Date.parse(START) + min * 60_000).toISOString();
const QA: ActorInfo = { login: 'qa1', name: '품질 담당', role: 'quality' };
const OP: ActorInfo = { login: 'op1', name: '현장 작업자', role: 'operator' };

describe('초물 대기 장부', () => {
  const entry = (simId: string, min: number, station = GATE) => ({
    simId, changeId: 0, station, since: at(min), category: 'MAN' as const, kind: 'shift' as const, detail: `변경 ${simId}`,
  });

  it('가장 오래 기다린 변경점을 답하고, 같은 번호는 한 번만 선다', () => {
    const l = new FaLedger();
    assert.equal(l.oldest(GATE), null);
    l.add(entry('S1', 1));
    l.add(entry('S2', 2));
    l.add(entry('S1', 3));
    assert.equal(l.list(GATE).length, 2);
    assert.equal(l.oldest(GATE)?.simId, 'S1');
    assert.equal(l.oldest('HL-AS-01'), null, '다른 설비는 따로');
  });

  it('초물 합격은 가리킨 변경점과 그보다 먼저 선 대기를 함께 푼다 (뒤에 선 것은 남는다)', () => {
    const l = new FaLedger();
    l.add(entry('S1', 1));
    l.add(entry('S2', 2));
    l.add(entry('S3', 5));
    const r = l.applyFirst(GATE, 'S2', 'OK', at(4), 'HL-1');
    assert.deepEqual(r.resolved.map((x) => x.simId), ['S1', 'S2']);
    assert.equal(r.target?.simId, 'S2');
    assert.deepEqual(l.list(GATE).map((x) => x.simId), ['S3']);
    assert.deepEqual(l.lastFirst(GATE), { at: at(4), serial: 'HL-1', result: 'OK', changeSimId: 'S2' });
  });

  it('초물 불합격이면 NG로 남아 계속 기다리고, 다음 초물이 합격하면 풀린다', () => {
    const l = new FaLedger();
    l.add(entry('S1', 1));
    l.add(entry('S2', 2));
    const ng = l.applyFirst(GATE, 'S2', 'NG', at(3), 'HL-1');
    assert.deepEqual(ng.resolved.map((x) => x.status), ['NG', 'NG'], '더 오래된 대기도 함께 불합격');
    assert.equal(l.oldest(GATE)?.status, 'NG', '대기는 그대로 (인터록은 계속 기다린다)');
    l.applyFirst(GATE, 'S2', 'OK', at(4), 'HL-2');
    assert.equal(l.oldest(GATE), null);
  });

  it('모르는 번호의 초물은 그 시각까지 선 대기를 판정한다 (놓친 메시지 하나로 라인이 서지 않게)', () => {
    const l = new FaLedger();
    l.add(entry('S1', 1));
    l.add(entry('S5', 9));
    const r = l.applyFirst(GATE, 'S4', 'OK', at(5), 'HL-1');
    assert.deepEqual(r.resolved.map((x) => x.simId), ['S1']);
    assert.equal(r.target, null);
    assert.deepEqual(l.list(GATE).map((x) => x.simId), ['S5']);
  });

  it('설비별 상태: 초물 대상 설비는 대기가 없어도 나온다', () => {
    const l = new FaLedger();
    l.add(entry('S1', 1, 'EM-PR-B')); // 초물 대상이 아닌 설비에도 사람 신고로 대기가 생길 수 있다
    const v = l.view();
    const fa = Object.values(STATIONS).filter((s) => faRequired(s)).length;
    assert.equal(v.length, fa + 1);
    assert.equal(v.find((x) => x.station === 'EM-PR-B')?.pending[0].simId, 'S1');
    assert.equal(v.find((x) => x.station === GATE)?.faRequired, true);
  });
});

describe('입력 검사', () => {
  it('신고: 설비·분류·내용을 확인하고, 초물 필요는 설비 기준으로 기본값을 정한다', () => {
    assert.throws(() => parseChangeRequest({}), /설비를 고르세요/);
    assert.throws(() => parseChangeRequest({ station: 'X-1', category: 'MAN', detail: 'a' }), /X-1/);
    assert.throws(() => parseChangeRequest({ station: GATE, category: 'MONEY', detail: 'a' }), /4M/);
    assert.throws(() => parseChangeRequest({ station: GATE, category: 'MAN', detail: '   ' }), /내용/);
    const p = parseChangeRequest({ station: GATE, category: 'MACHINE', detail: '  지그   교체 ', kind: 'pm' });
    assert.deepEqual(p, { station: GATE, line: 'HL', category: 'MACHINE', kind: 'user', detail: '지그 교체', fa: true });
    assert.equal(parseChangeRequest({ station: 'EM-PR-B', category: 'METHOD', detail: '조건' }).fa, false, '초물 대상이 아닌 설비');
    assert.equal(parseChangeRequest({ station: GATE, category: 'METHOD', detail: '조건', fa: false, kind: 'condition' }).kind, 'condition');
    assert.equal(parseChangeRequest({ station: GATE, category: 'MAN', detail: 'x'.repeat(500) }).detail.length, 200);
  });

  it('승인: 초물 판정이 끝나야 서명한다', () => {
    assert.match(approveBlockReason('PENDING', null) ?? '', /초물 검사 결과/);
    assert.match(approveBlockReason('NG', null) ?? '', /불합격/);
    assert.match(approveBlockReason('OK', new Date()) ?? '', /이미/);
    assert.equal(approveBlockReason('OK', null), null);
    assert.equal(approveBlockReason('NONE', null), null);
  });

  it('조회 한도·시각', () => {
    assert.equal(clampLimit(undefined, 300, 1000), 300);
    assert.equal(clampLimit('5000', 300, 1000), 1000);
    assert.equal(clampLimit('-3', 300, 1000), 300);
    assert.equal(parseTime('', '시작'), undefined);
    assert.throws(() => parseTime('어제', '시작'), /시작/);
  });
});

// ─────────────────────────── 서비스 (DB·브로커 없이) ───────────────────────────

type Row = Record<string, unknown> & { id: number };

/** prisma에서 이 서비스가 쓰는 만큼만 흉내 낸 메모리 DB */
function fakePrisma(seed: { run?: { id: number; startedAt: Date }; changes?: Row[]; inspections?: Row[] } = {}) {
  const tables: Record<'changePoint' | 'inspection', Row[]> = { changePoint: [...(seed.changes ?? [])], inspection: [...(seed.inspections ?? [])] };
  let seq = 100;
  const match = (r: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v === undefined) return true;
      if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(r[k]);
      if (v && typeof v === 'object' && ('gte' in (v as object) || 'lte' in (v as object))) {
        const t = (r[k] as Date).getTime();
        const { gte, lte } = v as { gte?: Date; lte?: Date };
        return (!gte || t >= gte.getTime()) && (!lte || t <= lte.getTime());
      }
      return r[k] === v;
    });
  const model = (name: keyof typeof tables) => ({
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: ++seq, simId: null, createdBy: null, faSerial: null, faAt: null, approvedBy: null, approvedAt: null, ...data } as Row;
      tables[name].push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const row = tables[name].find((r) => r.id === where.id);
      if (!row) throw new Error('없음');
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = tables[name].filter((r) => match(r, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    findUnique: async ({ where }: { where: { id: number } }) => tables[name].find((r) => r.id === where.id) ?? null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) => tables[name].find((r) => match(r, where)) ?? null,
    findMany: async ({ where, distinct, take }: { where?: Record<string, unknown>; distinct?: string[]; take?: number }) => {
      let rows = tables[name].filter((r) => match(r, where));
      if (distinct) {
        rows = [...rows].sort((a, b) => (b.at as Date).getTime() - (a.at as Date).getTime());
        const seen = new Set<unknown>();
        rows = rows.filter((r) => !seen.has(r[distinct[0]]) && seen.add(r[distinct[0]]));
      }
      return rows.slice(0, take ?? rows.length);
    },
  });
  const prisma = {
    simRun: { findFirst: async () => seed.run ?? null },
    changePoint: model('changePoint'),
    inspection: model('inspection'),
  };
  return { prisma: prisma as unknown as PrismaService, tables };
}

async function harness(seed?: Parameters<typeof fakePrisma>[0]) {
  let handler: (m: MqttInbound) => void = () => {};
  const commands: SimCommand[] = [];
  const broker = {
    onMessage: (h: (m: MqttInbound) => void) => (handler = h),
    sendCommand: async (c: SimCommand) => void commands.push(c),
  } as unknown as MqttBrokerService;
  const alarms: Pick<AlarmLive, 'station' | 'kind' | 'title' | 'severity'>[] = [];
  const clock = { run: null as string | null, now: null as string | null };
  const live = {
    get currentRun() {
      return clock.run;
    },
    get virtualNow() {
      return clock.now;
    },
    raiseAlarm: (station: string, severity: AlarmLive['severity'], kind: AlarmLive['kind'], title: string) => void alarms.push({ station, severity, kind, title }),
  } as unknown as LiveService;
  const runId = seed?.run?.id ?? 7;
  const writer = { resolveRun: async () => runId, currentRunId: runId } as unknown as ProductionWriter;
  const db = fakePrisma(seed);
  const svc = new QualitySystemService(db.prisma, live, writer, broker);
  await svc.onModuleInit();
  const send = (parts: string[], payload: unknown) => handler({ topic: `lt/v1/${parts.join('/')}`, parts, payload });
  const status = (startedAt: string, t: string): SimStatusMsg => ({ t, startedAt, speed: 60, running: true, scenarios: [], buffers: {}, inbound: {}, warehouse: {}, escaped: {} });
  return {
    svc, db, commands, alarms, clock,
    status: (startedAt: string, t: string) => {
      clock.run = startedAt;
      clock.now = t;
      send(['sim', 'status'], status(startedAt, t));
    },
    change: (m: Partial<ChangeMsg> & { id: string; t: string }) =>
      send(['HL', m.station ?? GATE, 'change'], { line: 'HL', station: GATE, category: 'MAN', kind: 'shift', detail: '주간 교대 시작', fa: true, ...m }),
    insp: (m: Partial<InspMsg> & { t: string; serial: string }) =>
      send(['HL', m.station ?? GATE, 'insp'], { line: 'HL', station: GATE, type: 'FIRST', result: 'OK', values: { bead_volume: 100 }, ...m }),
  };
}

describe('품질 시스템 서비스', () => {
  it('변경점 → 초물 대기 → 초물 불합격(알람) → 재초물 합격: 인터록 답과 DB 기록이 맞다', async () => {
    const h = await harness();
    h.status(START, at(10));
    h.change({ id: 'S1', t: at(1) });
    h.change({ id: 'S2', t: at(2), category: 'MATERIAL', kind: 'lot', detail: 'HOTMELT LOT A → B' });
    h.change({ id: 'S2', t: at(2) }); // 중복 수신
    h.change({ id: 'S3', t: at(3), fa: false, category: 'MACHINE', kind: 'repair' });
    assert.equal(h.svc.firstArticlePending(GATE)?.simId, 'S1');
    assert.equal(h.svc.firstArticlePending('HL-AS-01'), null);

    h.insp({ t: at(4), serial: 'HL-0001', change: 'S2', result: 'NG' });
    assert.equal(h.alarms.length, 1);
    assert.equal(h.alarms[0].kind, 'FA');
    assert.match(h.alarms[0].title, /초물 불합격/);
    assert.ok(h.svc.firstArticlePending(GATE), '불합격이면 계속 기다린다');

    h.insp({ t: at(5), serial: 'HL-0002', change: 'S2', result: 'OK' });
    assert.equal(h.svc.firstArticlePending(GATE), null);
    await h.svc.flushed();

    const cps = h.db.tables.changePoint;
    assert.equal(cps.length, 3, '중복 수신은 한 번만 저장');
    const by = (simId: string) => cps.find((r) => r.simId === simId)!;
    assert.equal(by('S1').faStatus, 'OK', '더 오래된 대기도 함께 판정');
    assert.equal(by('S2').faStatus, 'OK');
    assert.equal(by('S2').faSerial, 'HL-0002');
    assert.equal(by('S3').faStatus, 'NONE');
    assert.equal(by('S1').source, 'SIM');
    const ins = h.db.tables.inspection;
    assert.equal(ins.length, 2);
    assert.ok(ins.every((r) => r.changeId === by('S2').id), '초물 기록이 변경점에 이어진다');

    const fa = h.svc.faStatus().find((x) => x.station === GATE);
    assert.equal(fa?.pending.length, 0);
    assert.equal(fa?.lastFirst?.serial, 'HL-0002');
  });

  it('실행 구간 밖 시각은 버리고, 상태 전 메시지는 붙잡았다가 처리하고, 새 실행이면 장부를 비운다', async () => {
    const h = await harness();
    h.change({ id: 'S1', t: at(1) }); // 상태 전: 붙잡아 둔다
    assert.equal(h.svc.firstArticlePending(GATE), null);
    h.status(START, at(10));
    assert.equal(h.svc.firstArticlePending(GATE)?.simId, 'S1', '상태가 오면 처리');

    h.change({ id: 'S9', t: '2026-11-12T23:00:00.000Z' }); // 실행 시작 전
    h.change({ id: 'S8', t: at(60 * 20) }); // 지금보다 한참 뒤 (이전 실행의 늦은 메시지)
    assert.equal(h.svc.faStatus().find((x) => x.station === GATE)?.pending.length, 1);

    const next = at(30);
    h.status(next, at(31));
    assert.equal(h.svc.firstArticlePending(GATE), null, '새 실행');
    h.change({ id: 'S1', t: at(32) });
    assert.equal(h.svc.firstArticlePending(GATE)?.simId, 'S1', '번호는 실행 안에서만 뜻이 있다');
    await h.svc.flushed();
  });

  it('사람 신고: U<id> 변경점·change 명령·알람, 초물 전에는 승인 불가, 합격 뒤 승인', async () => {
    const h = await harness();
    h.status(START, at(10));
    const v = await h.svc.register({ station: GATE, category: 'MACHINE', detail: '도포 노즐 교체' }, OP);
    assert.equal(v.source, 'USER');
    assert.equal(v.simId, `U${v.id}`);
    assert.equal(v.createdBy, 'op1');
    assert.equal(v.faStatus, 'PENDING');
    assert.equal(v.at, at(10));
    assert.deepEqual(h.commands, [{ action: 'change', id: `U${v.id}`, code: GATE, category: 'MACHINE', kind: 'user', detail: '도포 노즐 교체', fa: true }]);
    assert.equal(h.svc.firstArticlePending(GATE)?.changeId, v.id);
    assert.equal(h.alarms[0].kind, 'CHANGE');

    await assert.rejects(h.svc.approve(v.id, QA), /초물 검사 결과/);
    h.insp({ t: at(12), serial: 'HL-0009', change: `U${v.id}`, result: 'OK' });
    await h.svc.flushed();
    const ok = await h.svc.approve(v.id, QA);
    assert.equal(ok.approvedBy, 'qa1');
    assert.equal(ok.faStatus, 'OK');
    await assert.rejects(h.svc.approve(v.id, QA), /이미/);
    await assert.rejects(h.svc.register({ station: GATE, category: 'MAN', detail: '' }, OP), /내용/);
  });

  it('실행을 모르면 신고를 받지 않는다', async () => {
    const h = await harness();
    await assert.rejects(h.svc.register({ station: GATE, category: 'MAN', detail: '교대' }, OP), /시뮬레이터/);
  });

  it('기동 때 마지막 실행의 초물 대기(PENDING·NG)와 마지막 초물을 되살린다', async () => {
    const run = { id: 3, startedAt: new Date(START) };
    const cp = (id: number, simId: string, min: number, faStatus: string) => ({
      id, runId: 3, simId, station: GATE, at: new Date(at(min)), category: 'MAN', kind: 'shift', detail: simId, faStatus,
    });
    const h = await harness({
      run,
      changes: [cp(1, 'S1', 1, 'OK'), cp(2, 'S2', 2, 'NG'), cp(3, 'S3', 3, 'PENDING'), cp(4, 'S4', 4, 'NONE')],
      inspections: [{ id: 1, runId: 3, station: GATE, type: 'FIRST', at: new Date(at(2.5)), serial: 'HL-7', result: 'NG', changeId: 2 }],
    });
    assert.deepEqual(h.svc.faStatus().find((x) => x.station === GATE)?.pending.map((x) => [x.simId, x.status]), [['S2', 'NG'], ['S3', 'PENDING']]);
    assert.equal(h.svc.firstArticlePending(GATE)?.changeId, 2);
    assert.deepEqual(h.svc.faStatus().find((x) => x.station === GATE)?.lastFirst, { at: at(2.5), serial: 'HL-7', result: 'NG', changeSimId: 'S2' });

    // 같은 실행이 이어지면 장부를 유지하고, 이미 받은 번호는 다시 저장하지 않는다
    h.status(START, at(5));
    h.change({ id: 'S3', t: at(3) });
    assert.equal(h.svc.faStatus().find((x) => x.station === GATE)?.pending.length, 2);
    h.insp({ t: at(6), serial: 'HL-8', change: 'S3', result: 'OK' });
    await h.svc.flushed();
    assert.equal(h.svc.firstArticlePending(GATE), null);
    assert.deepEqual(h.db.tables.changePoint.filter((r) => r.faStatus === 'OK').map((r) => r.simId).sort(), ['S1', 'S2', 'S3']);
  });

  it('조회: 지금 실행의 변경점을 필터로 고르고, 초물 기록에 변경점 번호를 붙인다', async () => {
    const h = await harness();
    h.status(START, at(10));
    h.change({ id: 'S1', t: at(1) });
    h.change({ id: 'S2', t: at(2), station: 'HL-AS-01', category: 'METHOD', kind: 'changeover' });
    h.insp({ t: at(3), serial: 'HL-1', change: 'S1' });
    h.insp({ t: at(4), serial: 'HL-2', type: 'MID' });
    await h.svc.flushed();
    assert.equal((await h.svc.changes({})).length, 2);
    assert.deepEqual((await h.svc.changes({ category: 'METHOD' })).map((c) => c.simId), ['S2']);
    assert.deepEqual((await h.svc.changes({ from: at(1.5) })).map((c) => c.simId), ['S2']);
    await assert.rejects(h.svc.changes({ line: 'XX' }), /라인/);
    const ins = await h.svc.inspections({ type: 'FIRST' });
    assert.equal(ins.length, 1);
    assert.equal(ins[0].changeSimId, 'S1');
    assert.deepEqual(ins[0].values, { bead_volume: 100 });
  });
});
