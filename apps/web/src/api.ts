import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "arsenal_token";
export const getToken = (): string | null => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};
export const setToken = (t: string | null): void => {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
};

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, data: unknown) {
    super(typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) { setToken(null); window.dispatchEvent(new Event("arsenal-logout")); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** Loads data from the backend; optional polling for live task status. */
export function useApi<T>(path: string | null, pollMs = 0): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = () => api<T>(path).then((d) => { if (alive) { setData(d); setError(null); setLoading(false); } }).catch((e: Error) => { if (alive) { setError(e.message); setLoading(false); } });
    void load();
    const id = pollMs ? setInterval(load, pollMs) : undefined;
    return () => { alive = false; if (id) clearInterval(id); };
  }, [path, pollMs, tick]);
  return { data, error, loading, reload };
}
