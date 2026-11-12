import {
  PM_PLANS,
  PM_REASON,
  PM_SOON,
  STATIONS,
  type FailureView,
  type MaintenanceReport,
  type PmStatus,
  type StationMaintenance,
} from '@lumitwin/shared';

/** 멈춘 구간 하나: 고장(DOWN)·계획 정지(STOP)·셋업(SETUP). end는 다음 상태 변화 시각 (아직 그 상태면 null) */
export interface HaltRow {
  station: string;
  state: string;
  reason: string | null;
  at: Date;
  end: Date | null;
}

const OPERATOR_TAG = ' (작업자 등록)';
const OPERATOR_BLANK = '작업자 고장 등록';
const HISTORY_MAX = 300;

/** 시뮬레이터가 작업자 고장 등록에 붙이는 꼬리표를 떼고, 누가 등록했는지 가른다 */
export function failureReason(raw: string | null): { reason: string; byOperator: boolean } {
  if (!raw) return { reason: '사유 없음', byOperator: false };
  if (raw === OPERATOR_BLANK) return { reason: '사유 미기재', byOperator: true };
  if (raw.endsWith(OPERATOR_TAG)) return { reason: raw.slice(0, -OPERATOR_TAG.length), byOperator: true };
  return { reason: raw, byOperator: false };
}

interface Span {
  state: string;
  reason: string | null;
  s: number;
  e: number;
  open: boolean;
}

const overlap = (x: Span, from: number, to: number) => Math.max(0, Math.min(x.e, to) - Math.max(x.s, from));

/**
 * 설비 보전 지표. 상태 기록에서 멈춘 구간만 받아 계산한다 (가동·대기 구간은 '나머지 시간'이라 필요 없다).
 * - 가동 시간 = 실행 시간 − 고장 − 계획 정지 − 셋업. 시뮬레이터 고장 모델은 이 시간 동안만 고장을 내므로 설계 MTBF와 바로 비교된다
 * - MTBF = 가동 시간 ÷ 고장 수 · MTTR = 끝난 고장의 평균 수리 시간 · 가용도 = 가동 ÷ (가동 + 고장)
 * - 계획 보전: 사유가 PM_REASON인 계획 정지가 끝난 시각이 마지막 PM. 그 뒤(없으면 실행 시작부터) 쌓인 가동 시간을 주기와 비교한다
 */
export function buildMaintenance(
  rows: HaltRow[],
  o: { runStartMs: number; nowMs: number; checks?: Map<string, { at: Date; ngCount: number }> },
): MaintenanceReport {
  const { runStartMs, nowMs } = o;
  const total = Math.max(0, nowMs - runStartMs);
  const spans = new Map<string, Span[]>();
  for (const r of rows) {
    if (!STATIONS[r.station]) continue;
    const s = Math.max(r.at.getTime(), runStartMs);
    const e = Math.min(r.end ? r.end.getTime() : nowMs, nowMs);
    if (e < s) continue;
    const list = spans.get(r.station) ?? [];
    list.push({ state: r.state, reason: r.reason, s, e, open: !r.end });
    spans.set(r.station, list);
  }

  const failures: FailureView[] = [];
  const pmWork: MaintenanceReport['pmWork'] = [];
  const stations: StationMaintenance[] = Object.values(STATIONS).map((def) => {
    const list = (spans.get(def.code) ?? []).sort((a, b) => a.s - b.s);
    let downMs = 0;
    let haltMs = 0;
    let repairs = 0;
    let repairMs = 0;
    let fails = 0;
    let last: FailureView | null = null;
    let pmEnd: number | null = null;
    let pmCount = 0;
    let pmOpen = false;
    for (const x of list) {
      const d = x.e - x.s;
      haltMs += d;
      if (x.state === 'DOWN') {
        fails++;
        downMs += d;
        if (!x.open) {
          repairs++;
          repairMs += d;
        }
        const { reason, byOperator } = failureReason(x.reason);
        last = {
          station: def.code, line: def.line, reason, byOperator,
          start: new Date(x.s).toISOString(), end: x.open ? null : new Date(x.e).toISOString(), sec: d / 1000,
        };
        failures.push(last);
      } else if (x.state === 'STOP' && x.reason === PM_REASON) {
        pmWork.push({ station: def.code, start: new Date(x.s).toISOString(), end: x.open ? null : new Date(x.e).toISOString() });
        if (x.open) pmOpen = true;
        else {
          pmCount++;
          pmEnd = x.e;
        }
      }
    }
    const upMs = Math.max(0, total - haltMs);
    const from = pmEnd ?? runStartMs;
    const sinceMs = Math.max(0, nowMs - from - list.reduce((a, x) => a + overlap(x, from, nowMs), 0));
    const plan = PM_PLANS[def.kind];
    const ratio = sinceMs / (plan.every * 3_600_000);
    const status: PmStatus = pmOpen ? 'doing' : ratio >= 1 ? 'due' : ratio >= PM_SOON ? 'soon' : 'ok';
    const check = o.checks?.get(def.code);
    const lastHalt = list[list.length - 1];
    return {
      station: def.code,
      line: def.line,
      down: !!lastHalt && lastHalt.state === 'DOWN' && lastHalt.open,
      failures: fails,
      downSec: downMs / 1000,
      repairs,
      repairSec: repairMs / 1000,
      upSec: upMs / 1000,
      mtbf: fails ? upMs / fails / 60_000 : null,
      mttr: repairs ? repairMs / repairs / 60_000 : null,
      designMtbf: def.mtbf,
      designMttr: def.mttr,
      availability: upMs + downMs > 0 ? upMs / (upMs + downMs) : null,
      lastFailure: last,
      pm: { plan, lastAt: pmEnd != null ? new Date(pmEnd).toISOString() : null, count: pmCount, sinceSec: sinceMs / 1000, status },
      check: check ? { at: check.at.toISOString(), ngCount: check.ngCount } : null,
    };
  });

  const byReason = new Map<string, { reason: string; count: number; sec: number; stations: Set<string> }>();
  for (const f of failures) {
    const r = byReason.get(f.reason) ?? { reason: f.reason, count: 0, sec: 0, stations: new Set<string>() };
    r.count++;
    r.sec += f.sec;
    r.stations.add(f.station);
    byReason.set(f.reason, r);
  }

  return {
    t: new Date(nowMs).toISOString(),
    runStartedAt: new Date(runStartMs).toISOString(),
    stations,
    failures: failures.sort((a, b) => b.start.localeCompare(a.start)).slice(0, HISTORY_MAX),
    pmWork: pmWork.sort((a, b) => b.start.localeCompare(a.start)).slice(0, HISTORY_MAX),
    reasons: [...byReason.values()].map((r) => ({ ...r, stations: [...r.stations] })).sort((a, b) => b.sec - a.sec),
  };
}
