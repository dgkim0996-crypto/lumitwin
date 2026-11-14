import {
  defaultDisposition,
  type AutoRule,
  type Disposition,
  type LineCode,
  type NcrOutcome,
  type NcrStatus,
  type NcrSummary,
} from '@lumitwin/shared';
import type { UnitStatus } from '../production/production.writer';

/**
 * 불량 처리(NCR) 규칙 (순수 함수): 자동 판정, 판정 뒤 NCR·개체 상태, 수리·재검사 결과, 결말, 요약, 번호.
 */

/** NCR 한 건의 메모리 모양 (DB Ncr 행과 같은 뜻, 시각은 가상 ISO) */
export interface NcrState {
  /** DB에 쓰기 전에는 0 */
  id: number;
  code: string;
  serial: string;
  item: string;
  line: LineCode;
  station: string;
  step: string;
  defect: string;
  variant: string | null;
  workOrder: number | null;
  status: NcrStatus;
  disposition: Disposition | null;
  rule: AutoRule | null;
  decidedBy: string | null;
  decidedAt: string | null;
  repairOk: boolean | null;
  repairMin: number | null;
  reinspect: 'OK' | 'NG' | null;
  attempt: number;
  openedAt: string;
  closedAt: string | null;
  note: string | null;
}

/** 자동 판정한 사람 이름 */
export const AUTO_DECIDER = 'MES 자동';

/**
 * 불량 판정 하나로 연 NCR의 첫 처리. 재검사에서 또 불합격이면 폐기(reinspect-ng),
 * 아니면 불량 처리 기준(mes.ts defaultDisposition): 불량 코드별 기준 → 검사 공정이면 수리 → 아니면 폐기. MRB면 사람을 기다린다
 */
export function initialDisposition(line: LineCode, station: string, defect: string, reinspect: boolean): { action: Disposition | 'MRB'; rule: AutoRule } {
  if (reinspect) return { action: 'SCRAP', rule: 'reinspect-ng' };
  const d = defaultDisposition(line, station, defect);
  return { action: d.action, rule: d.rule };
}

/** 판정 뒤 NCR 상태: 수리·재작업 = 수리 중 · 폐기·특채 = 종결 · MRB = 판정 대기 */
export function statusAfter(action: Disposition | 'MRB'): NcrStatus {
  if (action === 'MRB') return 'WAIT_MRB';
  return action === 'REPAIR' || action === 'REWORK' ? 'REPAIRING' : 'CLOSED';
}

/** 판정 뒤 개체 상태 (production_unit). MRB면 불량(NG) 그대로 둔다 */
export function unitStatusAfter(action: Disposition | 'MRB'): UnitStatus | null {
  if (action === 'REPAIR' || action === 'REWORK') return 'REPAIR';
  if (action === 'SCRAP') return 'SCRAP';
  if (action === 'UAI') return 'WIP';
  return null;
}

/** 사람이 판정할 수 있는 상태 (접수·MRB 대기) */
export const canDispose = (s: NcrStatus) => s === 'OPEN' || s === 'WAIT_MRB';

/** 수리대 결과를 NCR에 반영한다. 성공이면 재검사 대기, 실패면 폐기로 종결 */
export function applyRepair(n: NcrState, ok: boolean, minutes: number, t: string): { unit: UnitStatus; scrapped: boolean } {
  n.repairOk = ok;
  n.repairMin = Math.round(minutes * 10) / 10;
  if (ok) {
    n.status = 'REINSPECT';
    return { unit: 'WIP', scrapped: false };
  }
  n.status = 'CLOSED';
  n.closedAt = t;
  n.note = n.note ?? '수리 실패 → 폐기';
  return { unit: 'SCRAP', scrapped: true };
}

/** 재검사 결과를 NCR에 반영한다 (OK면 수리 합격 종결, NG면 이 NCR은 종결하고 새 NCR이 폐기로 열린다) */
export function applyReinspect(n: NcrState, result: 'OK' | 'NG', t: string): void {
  n.reinspect = result;
  n.status = 'CLOSED';
  n.closedAt = t;
}

/** 재검사 결과를 기다리는 NCR (수리대 결과보다 재검사 실적이 먼저 와도 찾는다) */
export function awaitingReinspect<T extends Pick<NcrState, 'status'>>(list: T[] | undefined): T | undefined {
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i];
    if (n.status === 'REINSPECT' || n.status === 'REPAIRING') return n;
  }
  return undefined;
}

/** 종결된 NCR의 결말 */
export function outcome(n: Pick<NcrState, 'status' | 'disposition' | 'repairOk' | 'reinspect'>): NcrOutcome | null {
  if (n.status !== 'CLOSED') return null;
  if (n.disposition === 'UAI') return 'UAI';
  if (n.disposition === 'SCRAP' || n.repairOk === false || n.reinspect === 'NG') return 'SCRAPPED';
  if (n.reinspect === 'OK') return 'REPAIRED';
  return null;
}

const ZERO: Record<NcrStatus, number> = { OPEN: 0, WAIT_MRB: 0, REPAIRING: 0, REINSPECT: 0, CLOSED: 0 };

/** 요약: 상태별 건수, 수리 성공률(수리·재작업이 끝난 건 중 재검사 합격), 평균 수리 시간, 폐기·특채 수, 불량 코드 상위 */
export function summarize(list: NcrState[], top = 5): NcrSummary {
  const byStatus = { ...ZERO };
  const defects = new Map<string, number>();
  let repairDone = 0;
  let repaired = 0;
  let minSum = 0;
  let minN = 0;
  let scrapped = 0;
  let uai = 0;
  for (const n of list) {
    byStatus[n.status]++;
    defects.set(n.defect, (defects.get(n.defect) ?? 0) + 1);
    if (n.repairMin != null) {
      minSum += n.repairMin;
      minN++;
    }
    const o = outcome(n);
    if (o === 'SCRAPPED') scrapped++;
    if (o === 'UAI') uai++;
    // 수리·재작업이 끝난 건: 수리 실패 또는 재검사 결과가 난 것
    if ((n.disposition === 'REPAIR' || n.disposition === 'REWORK') && (n.repairOk === false || n.reinspect != null)) {
      repairDone++;
      if (o === 'REPAIRED') repaired++;
    }
  }
  return {
    total: list.length,
    open: list.length - byStatus.CLOSED,
    byStatus,
    repairSuccess: repairDone ? repaired / repairDone : null,
    repairDone,
    avgRepairMin: minN ? Math.round((minSum / minN) * 10) / 10 : null,
    scrapped,
    uai,
    topDefects: [...defects].sort((a, b) => b[1] - a[1]).slice(0, top).map(([defect, n]) => ({ defect, n })),
  };
}

/** 작업지시 완료 조건: 수량만큼 투입했고, 투입한 것이 모두 양품 또는 폐기로 끝났다 */
export function woDone(w: { qty: number; released: number; doneQty: number; scrapQty: number }): boolean {
  return w.released >= w.qty && w.doneQty + w.scrapQty >= w.released;
}

const KST_MS = 9 * 3600_000;

/** 한국 시각 날짜 yymmdd (가상 시각 기준) */
export function kstDay(t: string | number | Date): string {
  return new Date(new Date(t).getTime() + KST_MS).toISOString().slice(2, 10).replace(/-/g, '');
}

export const ncrCode = (t: string, seq: number) => `NCR-${kstDay(t)}-${String(seq).padStart(4, '0')}`;
export const holdCode = (t: string, seq: number) => `HOLD-${kstDay(t)}-${String(seq).padStart(3, '0')}`;

/** 같은 날짜 접두어를 가진 번호 중 가장 큰 순번 (기동 때 순번을 이어 가려고) */
export function maxSeq(codes: string[], prefix: string): number {
  let m = 0;
  for (const c of codes) {
    if (!c.startsWith(prefix)) continue;
    const n = Number.parseInt(c.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}
