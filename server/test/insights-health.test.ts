import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { HEALTH_RUN_RATIO, PM_REASON, RUL_MIN_SAMPLES, STATIONS, VIB_ZONES, type AlarmLive, type HealthDef } from '@lumitwin/shared';
import { armedOf, decimate, estimateRul, fitLine, healthIndex, median, pdmStep, runningOnly, smoothedVib, type Sample } from '../src/insights/health-calc';
import { HealthService } from '../src/insights/health.service';

const T0 = Date.parse('2026-11-13T00:00:00Z');
const MIN = 60_000;
const Z2 = VIB_ZONES.II; // ab 1.12 · bc 2.8 · cd 7.1
const sample = (min: number, vib: number): Sample => ({ t: T0 + min * MIN, vib, cur: 10, temp: 40 });

/** 가상 1분 간격 표본: 진동 = a + b·(시간) + 잡음(결정적) */
function series(fromMin: number, toMin: number, a: number, perHour: number, noise = 0): Sample[] {
  const out: Sample[] = [];
  for (let m = fromMin; m < toMin; m++) out.push(sample(m, a + (perHour * (m - fromMin)) / 60 + noise * Math.sin(m * 1.7)));
  return out;
}

describe('예지 보전 계산', () => {
  it('멈춘 동안의 작은 진동은 빼고, 최근 가동 표본의 중앙값으로 등급을 정한다', () => {
    const s = [sample(0, 1.0), sample(1, 0.1), sample(2, 1.2), sample(3, 9.9), sample(4, 1.1), sample(5, 0.05)];
    assert.equal(runningOnly(s, 1.0).length, 4);
    assert.equal(runningOnly([sample(0, HEALTH_RUN_RATIO)], 1).length, 1);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    // 가동 표본 1.0, 1.2, 9.9, 1.1 중 최근 3개 중앙값 → 1.2 (튀는 한 점에 흔들리지 않음)
    assert.equal(smoothedVib(s, 1.0, 3), 1.2);
    assert.equal(smoothedVib([sample(0, 0.1)], 1.0), null);
  });

  it('최소제곱 직선', () => {
    const f = fitLine([0, 1, 2, 3], [1, 3, 5, 7])!;
    assert.equal(f.slope, 2);
    assert.equal(f.intercept, 1);
    assert.equal(f.se, 0);
    assert.equal(fitLine([1, 1, 1], [1, 2, 3]), null);
  });

  it('남은 수명: 직선 추세를 B/C·C/D 경계까지 외삽한다', () => {
    // 6시간 동안 1.0에서 시간당 0.1 mm/s씩 오름 → 지금 맞춘 값 ≈ 1.6, B/C(2.8)까지 12시간, C/D(7.1)까지 55시간
    const s = series(0, 360, 1.0, 0.1);
    const { rul } = estimateRul(s, { baseVib: 1.0, zones: Z2, nowMs: T0 + 360 * MIN });
    assert.ok(rul);
    assert.ok(Math.abs(rul.slopePerH - 0.1) < 1e-6);
    assert.ok(Math.abs(rul.warnH - (2.8 - (1.0 + 0.1 * (359 / 60))) / 0.1) < 0.11);
    assert.ok(Math.abs(rul.dangerH - (7.1 - (1.0 + 0.1 * (359 / 60))) / 0.1) < 0.11);
    assert.equal(rul.n, 360);
  });

  it('이미 경계를 넘었으면 0, 마지막 보전 전 표본은 쓰지 않는다', () => {
    const s = [...series(0, 120, 7.0, 1.0), ...series(120, 240, 1.0, 0.0, 0.01)];
    // 보전(120분) 전 표본까지 쓰면 추세가 꺾여 엉뚱하다. 보전 뒤만 쓰면 추세 없음
    const after = estimateRul(s, { baseVib: 1.0, zones: Z2, nowMs: T0 + 240 * MIN, sinceMs: T0 + 120 * MIN });
    assert.equal(after.rul, null);
    assert.match(after.note, /추세 없음/);
    const high = estimateRul(series(0, 120, 7.5, 0.5), { baseVib: 1.0, zones: Z2, nowMs: T0 + 120 * MIN });
    assert.equal(high.rul?.warnH, 0);
    assert.equal(high.rul?.dangerH, 0);
  });

  it('표본이 적거나 잡음뿐이면 남은 수명을 내지 않는다', () => {
    const few = estimateRul(series(0, RUL_MIN_SAMPLES - 1, 1.0, 1.0), { baseVib: 1.0, zones: Z2, nowMs: T0 + 60 * MIN });
    assert.equal(few.rul, null);
    assert.match(few.note, /표본 부족/);
    const flat = estimateRul(series(0, 200, 1.5, 0, 0.2), { baseVib: 1.0, zones: Z2, nowMs: T0 + 200 * MIN });
    assert.equal(flat.rul, null);
  });

  it('PDM 알람: 등급이 오를 때 한 번씩, 경계의 90% 밑으로 내려가면 다시 무장', () => {
    let a = pdmStep(0, 2.0, Z2);
    assert.deepEqual(a, { armed: 0, raise: null });
    a = pdmStep(a.armed, 3.0, Z2);
    assert.deepEqual(a, { armed: 1, raise: 'warn' });
    a = pdmStep(a.armed, 3.2, Z2);
    assert.equal(a.raise, null);
    a = pdmStep(a.armed, 2.6, Z2); // B/C 아래지만 2.52(90%) 위: 무장 유지
    assert.deepEqual(a, { armed: 1, raise: null });
    a = pdmStep(a.armed, 2.9, Z2);
    assert.equal(a.raise, null);
    a = pdmStep(a.armed, 7.5, Z2);
    assert.deepEqual(a, { armed: 2, raise: 'critical' });
    a = pdmStep(a.armed, 7.0, Z2); // 위험 경계 바로 밑: 다시 올라가도 알람 없음
    assert.deepEqual(a, { armed: 2, raise: null });
    a = pdmStep(a.armed, 1.2, Z2); // 보전 뒤
    assert.deepEqual(a, { armed: 0, raise: null });
    a = pdmStep(a.armed, 3.0, Z2);
    assert.equal(a.raise, 'warn');
    // 양호에서 바로 위험이면 위험 하나만
    assert.deepEqual(pdmStep(0, 8, Z2), { armed: 2, raise: 'critical' });
  });

  it('건강 지수·무장 상태·추이 줄이기', () => {
    assert.equal(healthIndex(1.0, 1.0, 7.1), 1);
    assert.equal(healthIndex(7.1, 1.0, 7.1), 0);
    assert.equal(healthIndex(4.05, 1.0, 7.1), 0.5);
    assert.equal(healthIndex(null, 1.0, 7.1), null);
    assert.equal(armedOf(3, Z2), 1);
    assert.equal(armedOf(null, Z2), 0);
    const pts = Array.from({ length: 250 }, (_, i) => ({ t: i, vib: i }));
    const d = decimate(pts, 120);
    assert.ok(d.length <= 120);
    assert.equal(d[d.length - 1].t, 249);
  });
});

describe('상태 감시 수신 (HealthService)', () => {
  const CODE = 'HL-AS-01';
  const def = STATIONS[CODE];
  const original = def.health;
  const health: HealthDef = { vib: 1.0, cur: 8, temp: 35, wearHours: 400, part: '감속기 베어링', cls: 'II', grade: 'assumed' };
  const START = '2026-11-13T00:00:00.000Z';

  let handler: (m: { topic: string; parts: string[]; payload: unknown }) => void = () => {};
  const alarms: Pick<AlarmLive, 'station' | 'severity' | 'kind' | 'title'>[] = [];
  const saved: unknown[] = [];
  const events = new EventEmitter();
  const live = {
    events,
    virtualNow: START as string | null,
    currentRun: START as string | null,
    raiseAlarm: (station: string, severity: AlarmLive['severity'], kind: AlarmLive['kind'], title: string) => {
      alarms.push({ station, severity, kind, title });
      return {} as AlarmLive;
    },
  };
  const mqtt = { onMessage: (h: typeof handler) => (handler = h) };
  const writer = { currentRunId: null as number | null, resolveRun: async () => 1 };
  const prisma = { healthSample: { createMany: async (x: { data: unknown[] }) => saved.push(...x.data) } };
  let svc: HealthService;

  const status = (t: string) => handler({ topic: '', parts: ['sim', 'status'], payload: { startedAt: START, t, speed: 60 } });
  const at = (min: number) => new Date(Date.parse(START) + min * MIN).toISOString();
  const send = (min: number, vib: number) => handler({ topic: '', parts: ['HL', CODE, 'health'], payload: { t: at(min), v: { vib, cur: 8, temp: 35 } } });

  before(async () => {
    def.health = health;
    svc = new HealthService(mqtt as never, live as never, writer as never, prisma as never);
    await svc.onModuleInit();
  });
  after(async () => {
    await svc.onModuleDestroy();
    def.health = original;
  });

  it('실행을 모르면(상태 메시지 전) 버리고, 실행 구간 밖 시각도 버린다', () => {
    send(1, 1.0);
    assert.equal(svc.received, 0);
    status(new Date(Date.parse(START) + 600 * MIN).toISOString());
    send(-5, 1.0); // 실행 시작 전
    assert.equal(svc.received, 0);
    send(10, 1.0);
    assert.equal(svc.received, 1);
  });

  it('진동이 B/C·C/D를 넘으면 PDM 알람을 한 번씩 내고, 보전 뒤 내려가면 다시 무장한다', () => {
    for (let m = 11; m < 20; m++) send(m, 1.0);
    for (let m = 20; m < 30; m++) send(m, 3.0);
    assert.deepEqual(
      alarms.map((a) => [a.kind, a.severity]),
      [['PDM', 'warn']],
    );
    for (let m = 30; m < 40; m++) send(m, 7.5);
    // 계획 보전: 40분에 세우고 50분에 다시 돈다 (보전 중 진동은 작아 등급에 안 들어간다)
    events.emit('state', CODE, 'STOP', PM_REASON, at(40));
    for (let m = 40; m < 50; m++) send(m, 0.1);
    events.emit('state', CODE, 'RUN', undefined, at(50));
    assert.equal(alarms.length, 2);
    assert.equal(alarms[1].severity, 'critical');
    for (let m = 50; m < 60; m++) send(m, 1.1); // 보전 뒤
    for (let m = 60; m < 70; m++) send(m, 3.1);
    assert.deepEqual(
      alarms.map((a) => a.severity),
      ['warn', 'critical', 'warn'],
    );
  });

  it('조회: 최신값·등급·추이·남은 수명 이유', async () => {
    live.virtualNow = at(70);
    const v = svc.view();
    const s = v.stations.find((x) => x.station === CODE)!;
    assert.equal(s.latest?.vib, 3.1);
    assert.equal(s.level, 'warn');
    assert.ok(s.trend.length > 0 && s.trend.every((p) => p.vib >= 0.6));
    // 보전(50분) 뒤 가동 표본 20개뿐이라 남은 수명은 아직 내지 않는다
    assert.deepEqual(s.lastMaint, { kind: 'pm', at: at(50) });
    assert.equal(s.rul, null);
    assert.match(s.rulNote, /표본 부족 \(가동 표본 20\//);
    const d = svc.detail(CODE);
    assert.equal(d.history.length, svc.received);
    assert.throws(() => svc.detail('NOPE'));
    // DB 기록은 2초마다 모아 쓴다
    const flush = () => (svc as unknown as { flush: () => Promise<void> }).flush();
    await flush();
    if (saved.length < svc.received) {
      await new Promise((r) => setTimeout(r, 50));
      await flush();
    }
    assert.equal(saved.length, svc.received);
  });
});
