/**
 * Thin fetch wrapper — every call goes through this so error handling, JSON parsing, and the
 * shared base URL live in one place. The base URL defaults to '/api' (Vite dev-server proxies
 * to the api workspace; production reverse proxy does the same).
 */
const BASE = (import.meta as unknown as { env: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? '/api';

export interface ApiError { status: number; message: string }

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : { message: await res.text() };
  if (!res.ok) throw { status: res.status, message: (body as { error?: string; message?: string }).error ?? body.message ?? res.statusText } as ApiError;
  return body as T;
}

/** Absolute path support: a path starting with '/../' escapes the /api base to the api root
 *  (used for /trading-agents, an older M4 route not under /api). */
export async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = path.startsWith('/../')
    ? new URL(path.slice(3), window.location.origin)
    : new URL(BASE + path, window.location.origin);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  return jsonOrThrow<T>(res);
}
