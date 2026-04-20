// ─────────────────────────────────────────────────────────────────────────────
// Sentry bootstrap — single place to init the SDK.
//
// Only fires when `NEXT_PUBLIC_SENTRY_DSN` is set, so a project without a
// Sentry account continues to work unchanged. Call `initSentryBrowser()` from
// a client-only entry (see instrumentation-client.ts); call
// `initSentryServer()` from instrumentation.ts's register() hook.
// ─────────────────────────────────────────────────────────────────────────────

// We import lazily so the SDK's module side-effects don't run in environments
// where the DSN isn't configured.
type SentryLike = typeof import("@sentry/nextjs");

const DEFAULT_TRACES_SAMPLE_RATE = 0.1;
const DEFAULT_REPLAYS_SAMPLE_RATE = 0.0; // session replay is opt-in (privacy + billing)

function _env(name: string): string {
  // Server + client both honour process.env. For the browser the value only
  // exists if the variable name starts with NEXT_PUBLIC_ at build time.
  return (typeof process !== "undefined" && process.env ? process.env[name] : "") || "";
}

function _dsn(): string {
  return _env("NEXT_PUBLIC_SENTRY_DSN") || _env("SENTRY_DSN");
}

function _tracesSampleRate(): number {
  const raw = _env("NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE");
  const n = raw ? Number(raw) : DEFAULT_TRACES_SAMPLE_RATE;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_TRACES_SAMPLE_RATE;
}

function _environment(): string {
  return _env("NEXT_PUBLIC_APP_ENV") || _env("NODE_ENV") || "development";
}

async function _load(): Promise<SentryLike | null> {
  try {
    return await import("@sentry/nextjs");
  } catch {
    return null;
  }
}

let _initialized = false;

export async function initSentryBrowser(): Promise<void> {
  if (_initialized) return;
  const dsn = _dsn();
  if (!dsn) return;
  const Sentry = await _load();
  if (!Sentry) return;
  Sentry.init({
    dsn,
    environment:        _environment(),
    tracesSampleRate:   _tracesSampleRate(),
    replaysSessionSampleRate: DEFAULT_REPLAYS_SAMPLE_RATE,
    replaysOnErrorSampleRate: 1.0,
    // Don't send default PII — if we want user info attached, we do it
    // explicitly via setUser() after auth completes.
    sendDefaultPii: false,
  });
  _initialized = true;
}

export async function initSentryServer(): Promise<void> {
  if (_initialized) return;
  const dsn = _dsn();
  if (!dsn) return;
  const Sentry = await _load();
  if (!Sentry) return;
  Sentry.init({
    dsn,
    environment:      _environment(),
    tracesSampleRate: _tracesSampleRate(),
    sendDefaultPii:   false,
  });
  _initialized = true;
}

/** Attach the currently authenticated user to subsequent events. */
export async function setSentryUser(user: { id?: string; email?: string } | null): Promise<void> {
  if (!_dsn()) return;
  const Sentry = await _load();
  if (!Sentry) return;
  if (!user) {
    Sentry.setUser(null);
    return;
  }
  Sentry.setUser({ id: user.id, email: user.email });
}

/** Fire-and-forget helper. Safe to call even without a DSN. */
export async function captureSentryException(err: unknown, context?: Record<string, unknown>): Promise<void> {
  if (!_dsn()) return;
  const Sentry = await _load();
  if (!Sentry) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
