import {
  CHANGE_DETAIL_MAX,
  CHANGE_USER_KINDS,
  STATIONS,
  faRequired,
  type ChangeCategory,
  type ChangeKind,
  type ChangeUserKind,
  type FaPendingView,
  type FaStationView,
  type FaStatus,
  type InspectionType,
  type LineCode,
} from '@lumitwin/shared';

// 품질 시스템의 판정 로직 (DB·MQTT 없이 테스트할 수 있게 서비스에서 뺐다)

export const CATEGORIES: readonly ChangeCategory[] = ['MAN', 'MACHINE', 'MATERIAL', 'METHOD'];
export const KINDS: readonly ChangeKind[] = ['shift', 'repair', 'lot', 'changeover', 'condition', 'pm', 'user'];
export const INSPECTION_TYPES: readonly InspectionType[] = ['FIRST', 'MID', 'LAST'];
export const LINE_CODES: readonly LineCode[] = ['HL', 'EM', 'OSM'];

/** 초물을 기다리는 변경점 하나 (메모리) */
export interface FaEntry {
  /** 변경점 번호 ('S12' 시뮬레이터 · 'U3' 사람 신고) */
  simId: string;
  /** ChangePoint.id. DB에 쓰기 전이면 0 */
  changeId: number;
  station: string;
  since: string;
  category: ChangeCategory;
  kind: ChangeKind;
  detail: string;
  status: 'PENDING' | 'NG';
}

export interface FirstResult {
  /** 이번 초물로 판정이 바뀐 변경점 (가리킨 변경점과 그 설비의 더 오래된 대기) */
  resolved: FaEntry[];
  /** 초물이 가리킨 변경점 (메모리에 있으면) */
  target: FaEntry | null;
}

/**
 * 설비별 초물 대기 장부. 인터록(실행 모듈)이 투입마다 묻기 때문에 DB가 아니라 메모리에서 바로 답한다.
 * - 변경점(fa)이 오면 그 설비 대기 줄 끝에 선다
 * - 초물 결과는 가리킨 변경점과 그보다 먼저 선 대기를 함께 판정한다 (시뮬레이터는 대기가 여럿이면 마지막 번호 하나로 묶어 초물을 낸다)
 * - 합격이면 줄에서 빠진다. 불합격이면 NG로 남고, 다음 개체가 다시 초물이 된다
 */
export class FaLedger {
  private pending = new Map<string, FaEntry[]>();
  private last = new Map<string, NonNullable<FaStationView['lastFirst']>>();

  reset(): void {
    this.pending.clear();
    this.last.clear();
  }

  /** 대기 추가. 같은 번호가 이미 있으면 그대로 둔다 (중복 수신) */
  add(e: Omit<FaEntry, 'status'> & { status?: FaEntry['status'] }): FaEntry {
    const list = this.pending.get(e.station) ?? [];
    const dup = list.find((x) => x.simId === e.simId);
    if (dup) return dup;
    const entry: FaEntry = { ...e, status: e.status ?? 'PENDING' };
    list.push(entry);
    this.pending.set(e.station, list);
    return entry;
  }

  /** 신고를 되돌릴 때 (명령을 못 보냈을 때) */
  remove(station: string, simId: string): void {
    const list = this.pending.get(station);
    if (list) this.pending.set(station, list.filter((x) => x.simId !== simId));
  }

  /**
   * 초물 결과 반영. 가리킨 번호가 장부에 없으면(그 변경점 메시지를 놓친 경우) 초물 시각까지 선 대기를 모두 그 결과로 본다:
   * 시뮬레이터 초물은 그때까지 쌓인 대기를 하나로 묶기 때문이다. 이렇게 해야 놓친 메시지 하나로 라인이 계속 기다리지 않는다
   */
  applyFirst(station: string, change: string | null | undefined, result: 'OK' | 'NG', at: string, serial: string): FirstResult {
    const list = this.pending.get(station) ?? [];
    const idx = change ? list.findIndex((x) => x.simId === change) : -1;
    const atMs = Date.parse(at);
    const resolved = idx >= 0 ? list.slice(0, idx + 1) : list.filter((x) => !(Date.parse(x.since) > atMs));
    const target = idx >= 0 ? list[idx] : null;
    if (result === 'OK') {
      const done = new Set(resolved);
      this.pending.set(station, list.filter((x) => !done.has(x)));
    } else {
      for (const x of resolved) x.status = 'NG';
    }
    this.last.set(station, { at, serial, result, changeSimId: change ?? null });
    return { resolved, target };
  }

  /** 인터록이 묻는 것: 이 설비에서 가장 오래 기다린 변경점 */
  oldest(station: string): FaEntry | null {
    return this.pending.get(station)?.[0] ?? null;
  }

  list(station: string): FaEntry[] {
    return this.pending.get(station) ?? [];
  }

  setLastFirst(station: string, v: NonNullable<FaStationView['lastFirst']>): void {
    this.last.set(station, v);
  }

  lastFirst(station: string): FaStationView['lastFirst'] {
    return this.last.get(station) ?? null;
  }

  /** 설비별 초물 상태: 초물 대상 설비 전부 + 대기·기록이 있는 설비 */
  view(): FaStationView[] {
    const out: FaStationView[] = [];
    for (const st of Object.values(STATIONS)) {
      const pending = this.list(st.code).map(toPendingView);
      const lastFirst = this.lastFirst(st.code);
      const fr = faRequired(st);
      if (fr || pending.length || lastFirst) out.push({ station: st.code, line: st.line, faRequired: fr, pending, lastFirst });
    }
    return out;
  }
}

export function toPendingView(e: FaEntry): FaPendingView {
  return { changeId: e.changeId, simId: e.simId, since: e.since, category: e.category, kind: e.kind, detail: e.detail, status: e.status };
}

// ─────────────────────────── 입력 검사 ───────────────────────────

export class InputError extends Error {}

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export interface ParsedChange {
  station: string;
  line: LineCode;
  category: ChangeCategory;
  kind: ChangeUserKind;
  detail: string;
  fa: boolean;
}

/** 사람 신고(POST /changes) 본문 검사. 초물 필요 여부를 안 보내면 설비가 초물 대상인지로 정한다 */
export function parseChangeRequest(body: unknown): ParsedChange {
  const b = (body ?? {}) as Record<string, unknown>;
  const station = clean(b.station, 20);
  const st = STATIONS[station];
  if (!st) throw new InputError(station ? `설비 ${station}이(가) 없습니다` : '설비를 고르세요');
  const category = b.category as ChangeCategory;
  if (!CATEGORIES.includes(category)) throw new InputError('4M 분류(사람·설비·자재·방법)를 고르세요');
  const kind = (CHANGE_USER_KINDS as readonly string[]).includes(b.kind as string) ? (b.kind as ChangeUserKind) : 'user';
  const detail = clean(b.detail, CHANGE_DETAIL_MAX);
  if (!detail) throw new InputError('변경 내용을 적어 주세요');
  const fa = typeof b.fa === 'boolean' ? b.fa : faRequired(st);
  return { station, line: st.line, category, kind, detail, fa };
}

/** 승인(서명)을 막는 이유. null이면 승인할 수 있다 — 초물 판정이 끝나야(합격 또는 대상 아님) 서명한다 */
export function approveBlockReason(faStatus: string, approvedAt: Date | string | null): string | null {
  if (approvedAt) return '이미 승인한 변경점입니다';
  if (faStatus === 'PENDING') return '초물 검사 결과가 아직 없습니다. 초물 합격 뒤 승인하세요';
  if (faStatus === 'NG') return '초물이 불합격입니다. 다시 한 초물이 합격한 뒤 승인하세요';
  return null;
}

/** 조회 개수 한도 */
export function clampLimit(v: string | undefined, def: number, max: number): number {
  const n = v == null || v === '' ? def : Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : def;
}

/** 쿼리 시각 (ISO). 비었으면 undefined, 잘못되면 오류 */
export function parseTime(v: string | undefined, name: string): Date | undefined {
  if (v == null || v === '') return undefined;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new InputError(`${name} 시각이 올바르지 않습니다: ${v}`);
  return new Date(ms);
}

/** 쿼리 값이 허용 목록에 있으면 그대로, 비었으면 undefined, 아니면 오류 */
export function pick<T extends string>(v: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (v == null || v === '') return undefined;
  if (!allowed.includes(v as T)) throw new InputError(`${name} 값이 올바르지 않습니다: ${v}`);
  return v as T;
}

/** DB 문자열 → 화면 상태 (모르는 값은 NONE) */
export function asFaStatus(v: string): FaStatus {
  return v === 'PENDING' || v === 'OK' || v === 'NG' ? v : 'NONE';
}
