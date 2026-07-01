// Single API client. Uses VITE_API_BASE in production (cross-origin Railway
// services) and the Vite dev proxy otherwise. Always sends the session cookie.
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") || "";

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
    throw new ApiError(res.status, (data as { error?: string }).error || res.statusText, (data as { details?: unknown }).details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  // Multipart upload (files) — let the browser set the Content-Type/boundary.
  upload: async <T>(path: string, form: FormData): Promise<T> => {
    const res = await fetch(`${BASE}/api${path}`, { method: "POST", credentials: "include", headers: authHeaders(), body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || res.statusText);
    return data as T;
  },
  base: BASE,
};
