// Single API client. Uses VITE_API_BASE in production (cross-origin Railway
// services) and the Vite dev proxy otherwise. Always sends the session cookie.
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") || "";
/** Absolute-URL base for non-fetch consumers (e.g. MapLibre tile templates). */
export const API_BASE = BASE;

// Bearer token auth. The web and API run on different *sites* (up.railway.app is a
// public suffix), so cookies are treated as third-party and blocked by browsers.
// We store the JWT in localStorage and send it via Authorization instead.
const TOKEN_KEY = "mh_token";
export function getAuthToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore storage errors */ }
}

function authHeaders(base?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(base ?? {}) };
  const t = getAuthToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Global session-expiry handler. When an *authenticated* request comes back 401,
// the stored token is invalid/expired and every in-flight call will fail the same
// way — so instead of relying on each call site to catch (some background pollers
// and stale-tab refetches don't), the auth layer registers one handler here that
// clears the session and returns the user to login. A 401 on the /auth/* routes is
// the expected "bad credentials" response and must NOT trip this.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}
function signalUnauthorizedIfSession(status: number, path: string): void {
  if (status === 401 && !path.startsWith("/auth/") && getAuthToken()) onUnauthorized?.();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    credentials: "include",
    headers: authHeaders(body !== undefined ? { "Content-Type": "application/json" } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    signalUnauthorizedIfSession(res.status, path);
    throw new ApiError(res.status, (data as { error?: string }).error || res.statusText, (data as { details?: unknown }).details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
  // Multipart upload (files) — let the browser set the Content-Type/boundary.
  upload: async <T>(path: string, form: FormData): Promise<T> => {
    const res = await fetch(`${BASE}/api${path}`, { method: "POST", credentials: "include", headers: authHeaders(), body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      signalUnauthorizedIfSession(res.status, path);
      throw new ApiError(res.status, (data as { error?: string }).error || res.statusText);
    }
    return data as T;
  },
  base: BASE,
};
