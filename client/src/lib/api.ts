import { CONTROL_KEY_HEADER, type SimCommand } from '@lumitwin/shared';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const key = controlKey();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(key ? { [CONTROL_KEY_HEADER]: key } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = body?.message ?? `요청 실패 (${res.status})`;
    throw new ApiError(Array.isArray(msg) ? msg.join(', ') : String(msg), res.status);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) }),
};

type Without<T, K extends keyof T> = Omit<T, K>;

/** 시뮬레이터 명령 (REST → MES → MQTT lt/v1/cmd) */
export function simCommand(cmd: SimCommand) {
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
