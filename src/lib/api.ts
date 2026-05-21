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

// Helper: build the headers bag for an auth'd request.  Extracted so the
// 401-retry path below can re-fetch the token without duplicating the
// header merge logic.
async function _buildAuthHeaders(
  options: RequestInit,
): Promise<HeadersInit> {
  const token = await getAuthToken();
  return {
    ...(options.headers as Record<string, string> | undefined ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// fetchWithAuth — vanilla fetch with the Supabase JWT bearer attached,
// plus a one-shot 401 retry-with-refresh.
//
// Why the retry:
//   The page-guard validates auth via `supabase.auth.getUser()`
//   (server-validated). `fetchWithAuth` reads the access token from
//   `supabase.auth.getSession()` (local cache). These two can disagree
//   transiently at page-mount: getUser() returns the user (token is
//   semantically valid), but the cached JWT we send via fetch can be
//   near-expiry / stale and the backend rejects with 401. Without a
//   retry, every panel that fires its first call right after mount
//   eats a 401 and surfaces an "error" UI that resolves itself on the
//   next user action — confusing and looks broken.
//
// On a 401 we ask supabase-js to refresh the session (which mints a
// fresh JWT from the refresh token) and retry exactly once. If the
// refresh itself fails, we surface the original 401 so the user gets
// a clean "please sign in again" path instead of an infinite loop.
export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  let res = await fetch(url, {
    ...options,
    headers: await _buildAuthHeaders(options),
  });
  if (res.status !== 401) return res;
  // Stale-token branch — refresh and retry once.
  try {
    await supabase.auth.refreshSession();
  } catch {
    return res;  // refresh failed → surface the original 401
  }
  res = await fetch(url, {
    ...options,
    headers: await _buildAuthHeaders(options),
  });
  return res;
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
    // User-facing copy — no port numbers, no uvicorn commands, no
    // env-var names, and (importantly) no first-person "our service"
    // framing that makes the app sound at fault. The actual failure
    // is just as often the publisher's CDN or an upstream rate limit
    // as it is our own backend, so we phrase the message as a
    // best-effort "couldn't fetch from the source" — neutral about
    // whose end is at fault, and consistent with the other soft-
    // access errors (paywall, anti-bot, etc.). The downstream
    // renderer already keys on "couldn't fetch" → soft access → muted
    // slate palette, so this falls into the existing grey treatment
    // without needing a new sentinel.
    //
    // "Open Paper" stays in the copy because renderErrorWithBoldOpenPaper
    // auto-bolds it, drawing the eye to the next-best action.
    //
    // For developers we still log the original message via
    // console.error so the technical detail is one DevTools click
    // away without leaking into the UI. The CONFIGURED_API_BASE /
    // env-var hint only matters to a developer running the app
    // locally, so it belongs in the console, not the paper card.
    try {
      const dev = !CONFIGURED_API_BASE
        ? "[explainFetchError] backend unreachable — NEXT_PUBLIC_API_BASE_URL is not set"
        : `[explainFetchError] backend unreachable at ${CONFIGURED_API_BASE}`;
      console.error(dev, error);
    } catch { /* console may be locked by the host */ }
    return "Couldn't fetch this paper from its source right now. Use Open Paper to grab it directly, or try again in a moment.";
  }
  if (lowered.includes("404")) {
    // Same neutral framing — a 404 most often means the upstream
    // publisher moved the resource or the source's record is stale,
    // not that our service is broken. Tech detail still flows to
    // console.error for devs.
    try {
      console.error(`[explainFetchError] 404 from ${CONFIGURED_API_BASE || "(no API base)"}`, error);
    } catch { /* ignore */ }
    return "Couldn't fetch this paper from its source right now — the page may have moved. Use Open Paper to read it directly, or try again shortly.";
  }
  return error.message;
}
