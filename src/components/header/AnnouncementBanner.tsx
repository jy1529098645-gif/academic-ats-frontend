// ─────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — shared public ticker.
//
// Expanded: single-card rotator with prev / next arrows + dot indicator.
//   • Text wraps onto multiple lines (line-clamp-2 keeps the banner height
//     predictable while still showing more than one line of copy).
//   • Hovering pauses auto-rotation.
//   • Clicking ‹ › lets the user page manually; dot indicator shows the
//     current position (or "n/total" text fallback when the feed is huge).
//
// Collapsed: danmu (bullet-comment) layer. Each announcement gets a
// deterministic Y / speed / colour keyed by its id, PLUS a staggered
// positive delay that keeps new messages from bunching with the existing
// ones. The fix for the "3 seeded messages overlap at launch" bug: we
// spread Y into distinct buckets based on index (not a hash that can
// collide), and give each one a deterministic positive delay so they
// enter the screen one-after-another instead of all at once.
//
// Theme coupling: the megaphone icon reads --ats-fg-accent so every theme
// tints it without needing its own class.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { Megaphone, MessageSquare, Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { Announcement } from "@/lib/hooks/use-announcements";

const ROTATE_INTERVAL_MS = 6000;
const DOT_LIMIT          = 10; // show dots when count <= DOT_LIMIT; else fallback to "n/m"

function formatAuthor(a: Announcement): string | null {
  const email = (a.author_email || "").toLowerCase();
  if (!email || email === "anonymous" || email.startsWith("anonymous@")) {
    return "Anonymous User";
  }
  if (email.includes("dev@")) return null; // system messages render without a byline
  return email.split("@")[0];
}

// ── One-at-a-time rotator (expanded banner) ────────────────────────────────

function AnnouncementRotator({
  items,
  paused,
}: {
  items: Announcement[];
  paused: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const count = items.length;

  useEffect(() => {
    if (paused || count <= 1) return;
    const id = window.setInterval(() => setIdx(i => (i + 1) % count), ROTATE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [paused, count]);

  const safeIdx = count > 0 ? idx % count : 0;
  const current = count > 0 ? items[safeIdx] : null;
  const prev = () => { if (count > 0) setIdx((safeIdx - 1 + count) % count); };
  const next = () => { if (count > 0) setIdx((safeIdx + 1) % count); };

  if (!current) {
    return (
      <span className="text-xs text-slate-500 italic">
        No announcements yet — send one with the input below.
      </span>
    );
  }

  const author = formatAuthor(current);
  const useDots = count > 1 && count <= DOT_LIMIT;

  return (
    <div className="flex items-center gap-2 min-w-0 w-full">
      {/* Prev arrow */}
      {count > 1 && (
        <button
          onClick={prev}
          title="Previous announcement"
          aria-label="Previous announcement"
          className="shrink-0 flex h-5 w-5 items-center justify-center rounded-md text-slate-500 hover:text-[var(--ats-fg-accent)] hover:bg-[var(--ats-bg-accent-soft)] transition-colors"
        >
          <ChevronLeft size={13} />
        </button>
      )}

      {/* Rotating card — keyed by announcement id so React remounts on step,
          playing the ticker-fade-in animation each time. */}
      <div
        key={current.id}
        translate="no"
        className="notranslate ticker-fade-in min-w-0 flex-1 flex items-start gap-2"
      >
        {author && (
          <span
            className="shrink-0 text-[10px] font-bold uppercase tracking-wide mt-[2px]"
            style={{ color: "var(--ats-fg-accent)" }}
          >
            {author}
          </span>
        )}
        <span className="min-w-0 flex-1 text-xs leading-snug text-slate-300 line-clamp-2 break-words">
          {current.text}
        </span>
      </div>

      {/* Indicator + next arrow */}
      {count > 1 && (
        <>
          {useDots ? (
            <div className="shrink-0 flex items-center gap-1 px-1" aria-label={`Announcement ${safeIdx + 1} of ${count}`}>
              {Array.from({ length: count }, (_, i) => {
                const active = i === safeIdx;
                return (
                  <button
                    key={i}
                    onClick={() => setIdx(i)}
                    title={`Go to announcement ${i + 1}`}
                    aria-label={`Go to announcement ${i + 1}`}
                    className="transition-all"
                    style={{
                      width:  active ? "16px" : "5px",
                      height: "5px",
                      borderRadius: "9999px",
                      backgroundColor: active
                        ? "var(--ats-fg-accent)"
                        : "var(--ats-border-subtle)",
                      opacity: active ? 1 : 0.6,
                    }}
                  />
                );
              })}
            </div>
          ) : (
            <span className="shrink-0 text-[10px] tabular-nums text-slate-500 px-1">
              {safeIdx + 1} <span className="opacity-50">/</span> {count}
            </span>
          )}
          <button
            onClick={next}
            title="Next announcement"
            aria-label="Next announcement"
            className="shrink-0 flex h-5 w-5 items-center justify-center rounded-md text-slate-500 hover:text-[var(--ats-fg-accent)] hover:bg-[var(--ats-bg-accent-soft)] transition-colors"
          >
            <ChevronRight size={13} />
          </button>
        </>
      )}
    </div>
  );
}

// ── Danmu (collapsed banner) ─────────────────────────────────────────────────

export type DanmuMsg = {
  id:     string;
  text:   string;
  yPct:   number;   // vertical bucket — evenly spread, stable per idx
  speed:  number;   // seconds-per-loop
  delay:  number;   // positive stagger so entries don't stack at launch
  color:  string;
  author: string;
};

const DANMU_COLORS = ["#60a5fa", "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#38bdf8", "#facc15"];
const DANMU_BUCKETS = 8; // evenly spaced Y rows so adjacent messages never pile up

/**
 * Stable danmu layout. Y is assigned by rotating through DANMU_BUCKETS so no
 * two adjacent messages share a row; speed / colour come from a hash of the
 * announcement id. Delay is strictly POSITIVE and increases with index so
 * the feed spawns left→right instead of all messages popping in on top of
 * each other at mount (which is what caused the visible stacking on load
 * with 3 seeded items).
 */
function makeDanmuMsg(a: Announcement, idx: number): DanmuMsg {
  const h = (Math.imul(idx + 1, 2654435761) >>> 0);
  const bucket = idx % DANMU_BUCKETS;
  const yPct = 8 + (bucket * (80 / DANMU_BUCKETS)); // 8 % .. 78 %, evenly
  return {
    id:     a.id,
    text:   a.text,
    yPct,
    speed:  34 + ((h >> 8) % 12),               // 34 s–46 s
    delay:  (idx % 8) * 2.2,                    // 0 s, 2.2 s, 4.4 s, …
    color:  DANMU_COLORS[(h >> 4) % DANMU_COLORS.length],
    author: formatAuthor(a) ?? "",
  };
}

// ── Banner props ────────────────────────────────────────────────────────────

export type AnnouncementBannerProps = {
  collapsed:    boolean;
  onCollapse:   () => void;
  onExpand:     () => void;
  announcements: Announcement[];
  msgInput:     string;
  setMsgInput:  (v: string) => void;
  msgAnonymous: boolean;
  setMsgAnonymous: (v: boolean) => void;
  msgSending:   boolean;
  msgSentOk:    boolean;
  onSend:       () => void;
};

export function AnnouncementBanner({
  collapsed, onCollapse, onExpand,
  announcements,
  msgInput, setMsgInput,
  msgAnonymous, setMsgAnonymous,
  msgSending, msgSentOk, onSend,
}: AnnouncementBannerProps) {
  const [hoverPaused, setHoverPaused] = useState(false);

  // Re-derive danmu only when the announcements array identity changes.
  // Keep the memo object stable so floating bullets don't restart their
  // CSS animations whenever a sibling re-renders.
  const danmuRef = useRef<DanmuMsg[]>([]);
  if (danmuRef.current.length !== announcements.length ||
      danmuRef.current.some((m, i) => m.id !== announcements[i]?.id)) {
    danmuRef.current = announcements.map((a, i) => makeDanmuMsg(a, i));
  }
  const danmu = danmuRef.current;

  if (collapsed) {
    return (
      <div className="h-full rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)] overflow-hidden flex flex-col">
        <div className="flex items-center gap-2 px-3 pr-10 shrink-0" style={{ height: "20px" }}>
          <span className="megaphone-breath shrink-0 flex items-center justify-center">
            <Megaphone size={11} className="shrink-0" style={{ color: "var(--ats-fg-accent)", opacity: 0.75 }} />
          </span>
          <div className="flex-1 h-px bg-gradient-to-r from-blue-500/25 via-purple-500/20 to-blue-500/25" />
          <button
            onClick={onExpand}
            title="Expand announcements"
            aria-label="Expand announcements"
            className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-[10px] text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 transition select-none"
          >▼</button>
        </div>
        <div translate="no" className="notranslate relative flex-1 overflow-hidden">
          {danmu.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-600 opacity-50 select-none pointer-events-none">
              Public messages will flow here as danmu ✦
            </div>
          ) : (
            danmu.map((msg) => (
              <span
                key={msg.id}
                className="absolute whitespace-nowrap text-[11px] font-medium select-none pointer-events-none"
                style={{
                  top: `${msg.yPct}%`,
                  left: 0,
                  color: msg.color,
                  opacity: 0.82,
                  animation: `danmuFloat ${msg.speed}s linear infinite`,
                  animationDelay: `${msg.delay}s`,
                  textShadow: "0 1px 4px rgba(0,0,0,0.35)",
                }}
              >
                {msg.author && <span className="mr-1 opacity-80">{msg.author}:</span>}
                {msg.text}
              </span>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col justify-between overflow-hidden rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)]"
      onMouseEnter={() => setHoverPaused(true)}
      onMouseLeave={() => setHoverPaused(false)}
    >
      {/* Rotator row — now supports arrows, dot indicator, and line-wrap */}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 pr-10">
        <span className="megaphone-breath shrink-0 flex items-center justify-center">
          <Megaphone size={13} className="shrink-0" style={{ color: "var(--ats-fg-accent)", opacity: 0.85 }} />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <AnnouncementRotator items={announcements} paused={hoverPaused} />
        </div>
        <button
          onClick={onCollapse}
          title="Collapse announcements"
          aria-label="Collapse announcements"
          className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-[10px] text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 transition select-none"
        >▲</button>
      </div>

      {/* Message input row */}
      <div className="flex items-center gap-1.5 border-t border-slate-800/50 px-3 py-1.5">
        <button
          onClick={() => setMsgAnonymous(!msgAnonymous)}
          title={msgAnonymous
            ? "Anonymous — your ID will not be shown on the ticker"
            : "Signed — your ID will appear next to the message"}
          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide transition select-none border ${
            msgAnonymous
              ? "bg-slate-700/30 text-slate-300 border-slate-600/50"
              : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
          }`}
        >
          {msgAnonymous ? "ANONYMOUS" : "SIGNED"}
        </button>
        <MessageSquare size={11} className="shrink-0 text-slate-600" />
        <input
          type="text"
          value={msgInput}
          onChange={(e) => setMsgInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !msgSending) void onSend(); }}
          placeholder={msgAnonymous ? "Send anonymously to every open tab…" : "Broadcast to every open tab…"}
          maxLength={280}
          className="min-w-0 flex-1 bg-transparent py-0.5 text-xs text-slate-300 outline-none placeholder:text-slate-700"
        />
        <button
          onClick={() => void onSend()}
          disabled={!msgInput.trim() || msgSending}
          className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
            msgSentOk
              ? "border-emerald-500/40 text-emerald-400"
              : "border-slate-700/50 text-slate-500 hover:border-blue-500/40 hover:text-blue-400"
          }`}
        >
          {msgSentOk
            ? <span className="inline-flex items-center gap-1"><Check size={11} strokeWidth={3} />Sent</span>
            : msgSending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

export { makeDanmuMsg as makeMsg };
