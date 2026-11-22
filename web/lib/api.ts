import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { t } from "./strings";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

type Envelope<T> = { data: T; meta?: { next_cursor?: string | null } };

// The access token lives in memory only (ARCHITECTURE.md §3).
let token: string | null = null;
let refreshing: Promise<boolean> | null = null;
let boot: Promise<boolean> | null = null;

export const setToken = (value: string) => {
  token = value;
};

const send = (method: string, path: string, body?: unknown) =>
  fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && !(body instanceof FormData) && { "Content-Type": "application/json" }),
    },
    body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
  });

// One refresh at a time: the server revokes every token of the user when a rotated one is reused.
function refreshToken() {
  return (refreshing ??= send("POST", "/auth/refresh")
    .then(async (res) => {
      token = res.ok ? (await res.json()).data.access_token : null;
      return res.ok;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    }));
}

/** Runs the refresh-cookie exchange once per page load. */
export const bootSession = () => (boot ??= refreshToken());

async function sendAuthed(method: string, path: string, body?: unknown) {
  const res = await send(method, path, body);
  return res.status === 401 && token && (await refreshToken()) ? send(method, path, body) : res;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
  const res = await sendAuthed(method, path, body);
  if (res.status === 204) return { data: undefined as T };
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, json?.error?.code ?? "", json?.error?.message ?? "", json?.error?.fields);
  }
  return json;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T = unknown>(path: string, body?: unknown) => call<T>("POST", path, body),
  patch: <T = unknown>(path: string, body: unknown) => call<T>("PATCH", path, body),
  put: <T = unknown>(path: string, body: unknown) => call<T>("PUT", path, body),
  del: (path: string) => call<unknown>("DELETE", path),
};

export async function fetchBlob(path: string) {
  const res = await sendAuthed("GET", path);
  if (!res.ok) throw new ApiError(res.status, "", "");
  return res.blob();
}

export function errorText(e: unknown) {
  if (!(e instanceof ApiError)) return t.errors.network;
  return (t.errors as Record<string, string>)[e.code] ?? (e.message || t.errors.generic);
}

export const fieldErrors = (e: unknown): Record<string, string> => (e instanceof ApiError && e.fields) || {};

/** Cursor-paginated list; `items` is every page loaded so far. */
export function usePaged<T>(key: unknown[], path: string) {
  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api.get<T[]>(
        pageParam ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(pageParam)}` : path,
      ),
    getNextPageParam: (last) => last.meta?.next_cursor || undefined,
  });
  return { ...q, items: q.data?.pages.flatMap((p) => p.data) ?? [] };
}

/** A mutation that refreshes every visible query when it succeeds. */
export function useAct<V = void, R = unknown>(fn: (v: V) => Promise<R>, onDone?: (r: R) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      qc.invalidateQueries();
      onDone?.(r);
    },
  });
}
