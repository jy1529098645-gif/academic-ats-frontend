// ─────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — shared public ticker.
//
// Layout (updated):
//   ┌─ Control strip ──────────────────────────────┐   ← thin, outside the card
//   │  ‹ ● ○ ○ ○ ○ ›                         ▲/▼  │
//   └──────────────────────────────────────────────┘
//   ┌─ Banner card ────────────────────────────────┐
//   │  [📣] author · message text (wrapped 2 lines) │   ← expanded: rotator
//   ├──────────────────────────────────────────────┤
//   │  [SIGNED] ✉️ input …                  [Send]  │
//   └──────────────────────────────────────────────┘
//
// Rationale for the strip split (this commit): the prev / next arrows,
// dot indicator, and collapse toggle used to live INSIDE the rotator
// row, eating horizontal space from the message itself. Pulling them up
// into a 16-px header strip above the banner frees the whole width of
// the card for the text + author byline, which matters because long
// announcements can now wrap onto two lines.
//
// When collapsed the card simply renders the danmu layer full-bleed;
// the strip stays put above it with just the ▼-expand button.
//
// Theme coupling: every interactive colour reads from --ats-* tokens so
// every theme tints without extra classes.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { Megaphone, MessageSquare, Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { Announcement } from "@/lib/hooks/use-announcements";

const ROTATE_INTERVAL_MS = 6000;
const DOT_LIMIT          = 10;

function formatAuthor(a: Announcement): string | null {
  const email = (a.author_email || "").toLowerCase();
  if (!email || email === "anonymous" || email.startsWith("anonymous@")) {
    return "Anonymous User";
  }
  if (email.includes("dev@")) return null;
  return email.split("@")[0];
}

// ── Expanded: main rotator card (text + author only; nav chrome is above) ──

function AnnouncementRotatorCard({
  items,
  paused,
  idx,
}: {
  items: Announcement[];
  paused: boolean;
  idx: number;
}) {
  const count = items.length;
  const safeIdx = count > 0 ? idx % count : 0;
  const current = count > 0 ? items[safeIdx] : null;

  if (!current) {
    return (
      <span className="text-xs text-slate-500 italic">
        No announcements yet — send one with the input below.
      </span>
    );
  }

  const author = formatAuthor(current);
  return (
    <div
      key={current.id}
      translate="no"
      className="notranslate ticker-fade-in flex items-start gap-2 min-w-0 w-full"
      aria-live={paused ? "off" : "polite"}
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
  );
}

// ── Control strip (always visible, sits above the banner card) ──────────────

function ControlStrip({
  count,
  idx,
  setIdx,
  collapsed,
  onCollapse,
  onExpand,
}: {
  count: number;
  idx: number;
  setIdx: (n: number) => void;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
}) {
  const safeIdx = count > 0 ? idx % count : 0;
  const useDots = count > 1 && count <= DOT_LIMIT;
  const prev = () => { if (count > 0) setIdx((safeIdx - 1 + count) % count); };
  const next = () => { if (count > 0) setIdx((safeIdx + 1) % count); };

  return (
    <div className="shrink-0 flex items-center gap-1 px-1" style={{ height: "18px" }}>
      {/* Nav chrome — only in expanded mode, only useful with >1 item. */}
      {!collapsed && count > 1 ? (
        <>
          <button
            onClick={prev}
            title="Previous announcement"
            aria-label="Previous announcement"
            className="shrink-0 flex h-4 w-4 items-center justify-center rounded text-slate-500 hover:text-[var(--ats-fg-accent)] hover:bg-[var(--ats-bg-accent-soft)] transition-colors"
          >
            <ChevronLeft size={11} />
          </button>
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
                      width:  active ? "14px" : "4px",
                      height: "4px",
                      borderRadius: "9999px",
                      backgroundColor: active ? "var(--ats-fg-accent)" : "var(--ats-border-subtle)",
                      opacity: active ? 1 : 0.55,
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
            className="shrink-0 flex h-4 w-4 items-center justify-center rounded text-slate-500 hover:text-[var(--ats-fg-accent)] hover:bg-[var(--ats-bg-accent-soft)] transition-colors"
          >
            <ChevronRight size={11} />
          </button>
        </>
      ) : (
        // Collapsed or single-item: leave the left side empty so the
        // collapse/expand button pins neatly to the right edge.
        <div className="flex-1" />
      )}
      <div className="ml-auto" />
      <button
        onClick={collapsed ? onExpand : onCollapse}
        title={collapsed ? "Expand announcements" : "Collapse announcements"}
        aria-label={collapsed ? "Expand announcements" : "Collapse announcements"}
        className="shrink-0 flex h-4 w-4 items-center justify-center rounded text-[10px] text-slate-500 hover:text-[var(--ats-fg-accent)] hover:bg-[var(--ats-bg-accent-soft)] transition-colors select-none"
      >
        {collapsed ? "▼" : "▲"}
      </button>
    </div>
  );
}

// ── Danmu (collapsed banner) ─────────────────────────────────────────────────

export type DanmuMsg = {
  id: string; text: string; yPct: number; speed: number; delay: number; color: string; author: string;
};

const DANMU_COLORS = ["#60a5fa", "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#38bdf8", "#facc15"];
const DANMU_BUCKETS = 8;

function makeDanmuMsg(a: Announcement, idx: number): DanmuMsg {
  const h = (Math.imul(idx + 1, 2654435761) >>> 0);
  const bucket = idx % DANMU_BUCKETS;
  const yPct = 8 + (bucket * (80 / DANMU_BUCKETS));
  return {
    id: a.id,
    text: a.text,
    yPct,
    speed: 34 + ((h >> 8) % 12),
    delay: (idx % 8) * 2.2,
    color: DANMU_COLORS[(h >> 4) % DANMU_COLORS.length],
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
  const [idx, setIdx] = useState(0);
  const count = announcements.length;

  // Auto-advance. Pauses when the user hovers the banner OR when the feed
  // has at most one item (nothing to rotate through).
  useEffect(() => {
    if (collapsed || hoverPaused || count <= 1) return;
    const id = window.setInterval(() => setIdx(i => (i + 1) % count), ROTATE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [collapsed, hoverPaused, count]);

  // Stable danmu payload — rebuild only when the announcements array
  // identity changes so in-flight bullets don't restart.
  const danmuRef = useRef<DanmuMsg[]>([]);
  if (danmuRef.current.length !== announcements.length ||
      danmuRef.current.some((m, i) => m.id !== announcements[i]?.id)) {
    danmuRef.current = announcements.map((a, i) => makeDanmuMsg(a, i));
  }
  const danmu = danmuRef.current;

  return (
    <div
      className="h-full flex flex-col gap-1"
      onMouseEnter={() => setHoverPaused(true)}
      onMouseLeave={() => setHoverPaused(false)}
    >
      {/* CONTROL STRIP — lives outside the card, doesn't eat banner space */}
      <ControlStrip
        count={count}
        idx={idx}
        setIdx={setIdx}
        collapsed={collapsed}
        onCollapse={onCollapse}
        onExpand={onExpand}
      />

      {/* BANNER CARD */}
      {collapsed ? (
        <div className="flex-1 min-h-0 rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)] overflow-hidden">
          {/* Danmu layer occupies the full card. The megaphone still
              sits at left as an ambient signal, but the old header strip
              (with its own collapse button) is gone — that chrome now
              lives in ControlStrip above. */}
          <div translate="no" className="notranslate relative w-full h-full overflow-hidden">
            <span className="absolute left-3 top-1.5 megaphone-breath flex items-center justify-center pointer-events-none" aria-hidden>
              <Megaphone size={11} style={{ color: "var(--ats-fg-accent)", opacity: 0.6 }} />
            </span>
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
      ) : (
        <div className="flex-1 min-h-0 flex flex-col justify-between overflow-hidden rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)]">
          {/* Rotator row — NO chrome here anymore; just megaphone + content.
              The full width is available for the announcement text. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
            <span className="megaphone-breath shrink-0 flex items-center justify-center">
              <Megaphone size={13} style={{ color: "var(--ats-fg-accent)", opacity: 0.85 }} />
            </span>
            <div className="min-w-0 flex-1 overflow-hidden">
              <AnnouncementRotatorCard items={announcements} paused={hoverPaused} idx={idx} />
            </div>
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
      )}
    </div>
  );
}

export { makeDanmuMsg as makeMsg };
