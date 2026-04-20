// ─────────────────────────────────────────────────────────────────────────────
// API transport layer — extracted from src/app/page.tsx so the same logic is
// shared across every future page, tested in isolation, and the main screen
// doesn't carry its own copy.
//
// Responsibilities:
//   - Resolve the API base URL (explicit env var first, then auto-detect).
//   - Wrap fetch() with a retry loop (exponential backoff + jitter) for
//     transport-level failures only — HTTP 4xx/5xx pass through unchanged.
//   - Attach Supabase auth tokens automatically for endpoints that require
//     them (via fetchWithAuth).
//   - Produce friendly error copy for the common no-backend / 404 cases.
//
// This module is intentionally free of React imports so it can be used from
// service workers, tests, or non-UI code paths in the future.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase/client";

const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";
export const CONFIGURED_API_BASE = RAW_API_BASE.replace(/\/+$/, "");

/** Legacy alias kept for callers that imported API_BASE_URL. */
export const API_BASE_URL =
  (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000").replace(/\/+$/, "");

let runtimeApiBase = CONFIGURED_API_BASE;

function normalizeBase(base: string): string {
  return (base || "").replace(/\/+$/, "");
}

export function buildApiUrl(path: string, baseOverride?: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`API path must start with "/": ${path}`);
  }
  const base = normalizeBase(baseOverride ?? runtimeApiBase);
  return base ? `${base}${path}` : path;
}

function getApiBaseCandidates(): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    const normalized = normalizeBase(value);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  if (CONFIGURED_API_BASE) {
    // Explicit base is configured — only try it and same-host:8000.
    // Do NOT fall back to the relative-path ("") candidate: that would hit
    // the Next.js server which always 404s for /api/* it doesn't own.
    push(CONFIGURED_API_BASE);
  } else {
    push("");
  }

  if (typeof window !== "undefined") {
    const { protocol, hostname, port } = window.location;
    if (hostname) {
      const defaultPort = protocol === "https:" ? "443" : "80";
      if (port !== "8000") {
        push(`${protocol}//${hostname}:8000`);
      }
      if (port && port !== defaultPort) {
        push(`${protocol}//${hostname}`);
      }
    }
  }

  return candidates;
}

/** Thrown when every retry failed with a transport-level error (no HTTP response). */
export class NetworkError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  if ((err as { name?: string }).name === "AbortError") return false;
  if (err instanceof TypeError) return true;
  const msg = (err as { message?: string }).message || "";
  return /network|failed to fetch|load failed|ECONN|ETIMEDOUT|fetch failed/i.test(msg);
}

async function tryFetchOnce(path: string, init?: RequestInit): Promise<{ res: Response }> {
  const candidates = getApiBaseCandidates();
  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const res = await fetch(buildApiUrl(path, candidate), init);
      if (res.ok) {
        runtimeApiBase = normalizeBase(candidate);
        return { res };
      }
      lastResponse = res;
      if (res.status !== 404) {
        return { res }; // non-404 HTTP error is not retry-worthy.
      }
    } catch (error) {
      lastError = error;
      if (CONFIGURED_API_BASE && candidate === normalizeBase(CONFIGURED_API_BASE)) {
        throw lastError;
      }
    }
  }
  if (lastResponse) return { res: lastResponse };
  throw lastError ?? new Error("Request failed.");
}

/**
 * Exponential backoff with jitter. Attempt index (0-based) → delay in ms.
 * Base 500 ms, doubles each attempt, caps at 4 s, plus a 0–30 % random jitter
 * so fleets of clients don't synchronise their retry storms.
 */
function retryDelayMs(attempt: number): number {
  const base = 500;
  const capped = Math.min(base * Math.pow(2, attempt), 4000);
  const jitter = capped * (Math.random() * 0.3);
  return Math.round(capped + jitter);
}

const MAX_RETRIES = 3;

export async function fetchWithApiFallback(
  path: string,
  init?: RequestInit,
  preferBlob = false,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { res } = await tryFetchOnce(path, init);
      return res;
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") throw err;
      if (!isNetworkError(err)) {
        throw err instanceof Error
          ? err
          : new Error(preferBlob ? "Download failed." : "Request failed.");
      }
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      await new Promise(r => setTimeout(r, retryDelayMs(attempt)));
    }
  }
  throw new NetworkError(
    preferBlob
      ? `Download failed after ${MAX_RETRIES + 1} tries — the backend appears to be unreachable.`
      : `Network error: the backend is unreachable (auto-retried ${MAX_RETRIES} times).`,
    lastErr,
  );
}

// ── Auth helpers ────────────────────────────────────────────────────────────
// Always calls getSession() fresh so the token is never stale.

export async function getAuthToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> | undefined ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export function explainFetchError(error: unknown): string {
  if (!(error instanceof Error)) return "Request failed.";
  const lowered = error.message.toLowerCase();
  if (
    lowered.includes("failed to fetch") ||
    lowered.includes("networkerror") ||
    lowered.includes("load failed") ||
    lowered.includes("connection refused") ||
    lowered.includes("econnrefused")
  ) {
    if (!CONFIGURED_API_BASE) {
      return "Cannot reach the backend. No NEXT_PUBLIC_API_BASE_URL is configured. Set it to your FastAPI service URL (e.g. http://localhost:8000) and restart the frontend.";
    }
    return `Cannot reach the backend at ${CONFIGURED_API_BASE}. Please start (or restart) the Python backend with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload`;
  }
  if (lowered.includes("404")) {
    if (!CONFIGURED_API_BASE) {
      return "The request returned 404. No NEXT_PUBLIC_API_BASE_URL is configured — set it to your FastAPI backend URL (e.g. http://localhost:8000), then restart the frontend.";
    }
    return `The request returned 404 from ${CONFIGURED_API_BASE}. The backend is reachable but the route is missing — make sure you are running the latest version of main.py and that the backend was restarted after any code changes.`;
  }
  return error.message;
}
