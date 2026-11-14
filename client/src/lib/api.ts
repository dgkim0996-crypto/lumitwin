import { CONTROL_KEY_HEADER, type SimControlCommand } from '@lumitwin/shared';

/** 화면과 같은 주소의 /api/v1 (Next rewrites가 MES 서버로 넘긴다) */
export const API = '/api/v1';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const KEY_STORE = 'lumitwin.controlKey';

/** 공개 링크에서 조작하려고 넣은 제어 키 (이 브라우저에만 남는다) */
export function controlKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}

export function setControlKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* 저장소를 못 쓰는 창(사생활 보호 모드 등)에서는 키를 기억하지 않는다 */
  }
}

/** 서버가 401(로그인 필요)을 돌려주면 알린다: 사용자 메뉴가 듣고 로그인 상태를 다시 읽는다 (화면을 옮기지는 않는다) */
export const AUTH_EXPIRED_EVENT = 'lumitwin:auth-expired';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const key = controlKey();
  const res = await fetch(`${API}${path}`, {
    ...init,
    // 로그인 쿠키(httpOnly)는 같은 주소로만 실린다
    credentials: 'same-origin',
    // 파일 올리기(FormData)는 브라우저가 multipart 경계를 붙이도록 content-type을 비워 둔다
    headers: { ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(key ? { [CONTROL_KEY_HEADER]: key } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: { message?: unknown } | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 프록시 오류 페이지(HTML) 등 JSON이 아닌 응답
    if (res.ok) throw new ApiError('서버 응답을 읽지 못했습니다', res.status);
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    // 401 '로그인이 필요합니다' · 403 '<권한> 권한이 없습니다 (<역할>)' · 403 보기 전용 문구를 서버가 준 그대로 보여 준다
    const msg = body?.message ?? (res.status === 401 ? '로그인이 필요합니다' : `요청 실패 (${res.status})`);
    throw new ApiError(Array.isArray(msg) ? msg.join(', ') : String(msg), res.status);
  }
  return body as T;
}

/** 로그인·권한 때문에 막힌 요청인가 (401·403) */
export function isDenied(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body == null ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** multipart 올리기 (파일 + 글 필드) */
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
};

type Without<T, K extends keyof T> = Omit<T, K>;

/** 시뮬레이터 명령 (REST → MES → MQTT lt/v1/cmd) */
export function simCommand(cmd: SimControlCommand) {
  switch (cmd.action) {
    case 'speed':
      return api.post('/sim/speed', { speed: cmd.speed });
    case 'scenario':
      return api.post('/sim/scenario', { id: cmd.id, on: cmd.on } satisfies Without<typeof cmd, 'action'>);
    case 'station':
      return api.post('/sim/station', { code: cmd.code, op: cmd.op, reason: cmd.reason });
    default:
      return api.post(`/sim/${cmd.action}`);
  }
}
