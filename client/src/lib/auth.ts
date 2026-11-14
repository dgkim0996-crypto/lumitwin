'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERM_NAMES, PERMISSIONS, ROLE_NAMES, can as canRole, type ActorInfo, type MeView, type PermCode, type Role } from '@lumitwin/shared';
export type { AuditRow, AuditView, MeView } from '@lumitwin/shared';
import { READ_ONLY_TITLE, useAccess } from './access';
import { api } from './api';

/**
 * 로그인한 사용자와 권한 (P9). 화면은 can('wo.manage')로 버튼을 막고, 서버도 같은 권한표(shared PERMISSIONS)로 401·403을 낸다.
 * 서버 인증이 꺼져 있으면(AUTH=off) 모든 권한을 연다. 화면에서 막는 것은 안내일 뿐이고 실제 판정은 서버가 한다
 */
export const AUTH_KEY = ['auth', 'me'] as const;
export const AUDIT_KEY = ['audit'] as const;

export interface AuthState {
  user: ActorInfo | null;
  /** 서버 인증이 켜져 있는가 (AUTH=on) */
  enabled: boolean;
  loading: boolean;
  can: (perm: PermCode) => boolean;
  /** 막힌 이유 (할 수 있으면 undefined): 로그인 필요 · 권한 없음 */
  why: (perm: PermCode) => string | undefined;
  demo: boolean;
}

/** 이 권한을 가진 역할 이름들: '조장·관리자' */
export function rolesFor(perm: PermCode): string {
  return PERMISSIONS[perm].map((r) => ROLE_NAMES[r]).join('·');
}

export function useAuth(): AuthState {
  const q = useQuery({ queryKey: AUTH_KEY, queryFn: () => api.get<MeView>('/auth/me'), staleTime: 60_000, refetchOnWindowFocus: true });
  // 처음 읽는 동안은 막아 두고(버튼이 열렸다 닫히며 깜빡이지 않게), 서버에 /auth/me가 없거나 닿지 않으면 막지 않는다 (서버가 다시 판정한다)
  const loading = q.isPending;
  const enabled = q.data ? q.data.enabled : loading;
  const user = q.data?.user ?? null;
  const why = (perm: PermCode): string | undefined => {
    if (!enabled) return undefined;
    if (loading) return '로그인 상태를 확인하는 중입니다';
    return deniedReason(perm, user);
  };
  return { user, enabled, loading, can: (perm) => !why(perm), why, demo: q.data?.demo ?? false };
}

/** 로그인한 사람(없으면 null)이 이 권한으로 못 하는 이유. 할 수 있으면 undefined */
export function deniedReason(perm: PermCode, user: ActorInfo | null): string | undefined {
  if (!user) return `로그인이 필요합니다 (${PERM_NAMES[perm]}: ${rolesFor(perm)})`;
  if (!canRole(user.role, perm)) return `${PERM_NAMES[perm]} 권한이 없습니다 (${ROLE_NAMES[user.role]}) · ${rolesFor(perm)}만 할 수 있습니다`;
  return undefined;
}

/** 권한이 없어 막힌 버튼의 설명. user를 주면(로그인 안 했으면 null) 그 사람 기준으로 */
export function deniedTitle(perm: PermCode, user?: ActorInfo | null): string {
  if (user !== undefined) return deniedReason(perm, user) ?? '';
  return `${PERM_NAMES[perm]} 권한이 필요합니다 (${rolesFor(perm)})`;
}

/**
 * 버튼 하나를 막을지: 공개 링크 보기 전용이 먼저, 그다음 로그인·권한.
 * `const g = useGate('sim.control')` → `disabled={!g.ok} title={g.title}`
 */
export function useGate(perm: PermCode): { ok: boolean; title?: string; readOnly: boolean } {
  const { readOnly } = useAccess();
  const auth = useAuth();
  if (readOnly) return { ok: false, title: READ_ONLY_TITLE, readOnly: true };
  const why = auth.why(perm);
  return why ? { ok: false, title: why, readOnly: false } : { ok: true, readOnly: false };
}

export interface LoginBody {
  login: string;
  password?: string;
  /** 시연 계정 버튼 (서버가 기본 비밀번호를 쓸 때만 받는다) */
  demo?: boolean;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: LoginBody) => api.post<{ user: ActorInfo; expiresAt: string }>('/auth/login', b),
    onSuccess: async (r) => {
      qc.setQueryData<MeView>(AUTH_KEY, (m) => ({ enabled: true, demo: m?.demo ?? false, user: r.user }));
      qc.removeQueries({ queryKey: AUDIT_KEY });
      await qc.invalidateQueries({ queryKey: AUTH_KEY });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/auth/logout'),
    onSettled: async () => {
      qc.setQueryData<MeView>(AUTH_KEY, (m) => (m ? { ...m, user: null } : m));
      qc.removeQueries({ queryKey: AUDIT_KEY });
      await qc.invalidateQueries({ queryKey: AUTH_KEY });
    },
  });
}

/** 로그인 뒤 돌아갈 주소: 같은 사이트 안의 경로만 (다른 사이트로 보내는 링크를 막는다) */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.startsWith('/login')) return '/';
  return next;
}

// ─────────────────────────── 감사 기록 ───────────────────────────

/** 감사 기록의 동작 이름. 다른 화면(작업지시·불량 처리·Hold·변경점)이 남기는 코드는 앞부분으로 묶어 부른다 */
const ACTION_NAMES: Record<string, string> = {
  login: '로그인',
  'login.fail': '로그인 실패',
  logout: '로그아웃',
  'sim.speed': '배속 변경',
  'sim.pause': '시뮬레이터 일시정지',
  'sim.resume': '시뮬레이터 재개',
  'sim.reset': '시뮬레이터 초기화',
  'sim.scenario': '이상 시나리오',
  'station.stop': '설비 계획 정지',
  'station.setup': '설비 셋업',
  'station.start': '설비 재가동',
  'station.fail': '고장 등록',
  'station.repair': '수리 완료',
  'station.pm': '보전 실시',
  'alarm.ack': '알람 확인',
  'check.record': '작업 전 점검',
  'wo.create': '작업지시 만들기',
  'wo.update': '작업지시 수량 수정',
  'wo.reorder': '작업지시 순서 변경',
  'wo.cancel': '작업지시 중단',
  'ncr.dispose': '불량 처리 판정',
  'hold.create': 'Hold 걸기',
  'hold.release': 'Hold 해제·폐기',
  'change.register': '변경점 신고',
  'change.approve': '변경점 승인',
  'change.first-article': '수동 초물 판정',
};
const ACTION_GROUPS: [string, string][] = [
  ['wo.', '작업지시'],
  ['ncr.', '불량 처리'],
  ['hold.', 'Hold'],
  ['change.', '변경점'],
  ['insp', '초·중·종물'],
  ['fa.', '초물'],
  ['pm.', '보전'],
  ['user.', '계정'],
];

export function actionName(code: string): string {
  if (Object.prototype.hasOwnProperty.call(ACTION_NAMES, code)) return ACTION_NAMES[code];
  if (Object.prototype.hasOwnProperty.call(PERM_NAMES, code)) return PERM_NAMES[code as PermCode];
  const g = ACTION_GROUPS.find(([p]) => code.startsWith(p));
  return g ? `${g[1]} · ${code.slice(code.indexOf('.') + 1)}` : code;
}

export const isRole = (v: string): v is Role => Object.prototype.hasOwnProperty.call(ROLE_NAMES, v);
