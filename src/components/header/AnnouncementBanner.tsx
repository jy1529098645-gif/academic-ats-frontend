// ─────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — shared public ticker.
//
// Two modes, both driven by the same announcements[] prop:
//
//  1. Expanded: a single-card rotator. One message shows at a time, cycles
//     every 6 s with a soft fade-in. Key advantages over the previous
//     marquee:
//       • New messages slot into the rotation without restarting the
//         animation — the current card stays up until its dwell ends.
//       • Hovering the banner pauses the rotation so users can read long
//         messages.
//       • Pure state machine — no CSS animation duration tied to list
//         length, so there's no "content width changed → jump" glitch.
//
//  2. Collapsed: translucent strip where the same announcements float
//     across as bullet-comments (danmu). Each message is keyed by a
//     deterministic hash of its id so layout stays stable when the list
//     updates; a new message appends at the end without reshuffling the
//     existing ones.
//
// Theme coupling: the megaphone icon reads its colour from
// --ats-fg-accent so every theme (night-amber / night-emerald / Cherry
// Blossom / …) tints it automatically. The old hardcoded text-blue-400/70
// bypassed the global remap because Tailwind's opacity-modifier compiles
// to a distinct class.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { Megaphone, MessageSquare, Check } from "lucide-react";
import type { Announcement } from "@/lib/hooks/use-announcements";

const ROTATE_INTERVAL_MS = 6000;

// ── One-at-a-time rotator (expanded banner) ────────────────────────────────

function formatAuthor(a: Announcement): string | null {
  const email = (a.author_email || "").toLowerCase();
  if (!email || email === "anonymous" || email.startsWith("anonymous@")) {
    return "Anonymous User";
  }
  // Seed dev messages render without a prefix to stay subtle.
  if (email.includes("dev@")) return null;
  return email.split("@")[0];
}

function AnnouncementRotator({
  items,
  paused,
}: {
  items: Announcement[];
  paused: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const count = items.length;

  // Advance every ROTATE_INTERVAL_MS unless paused or only one item.
  useEffect(() => {
    if (paused || count <= 1) return;
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % count);
    }, ROTATE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [paused, count]);

  // Clamp idx when the feed shrinks (e.g. after a dev "clear all").
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
  // Position indicator (e.g. "3 / 14") stays stable across renders so the
  // user has a sense of progress through the feed.
  return (
    <div
      key={current.id}
      // translate="no" because React remounts this every rotation; letting
      // Google Translate grab the node between renders crashes with a
      // "removeChild" DOM mismatch.
      translate="no"
      className="notranslate ticker-fade-in flex items-center gap-2 min-w-0 w-full"
    >
      {author && (
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--ats-fg-accent)" }}>
          {author}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-xs leading-relaxed text-slate-300">
        {current.text}
      </span>
      {count > 1 && (
        <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
          {safeIdx + 1} / {count}
        </span>
      )}
    </div>
  );
}

// ── Danmu (collapsed banner) ─────────────────────────────────────────────────

export type DanmuMsg = {
  id:     string;
  text:   string;
  y:      number;
  speed:  number;
  delay:  number;
  color:  string;
  author: string;
};

/** Deterministic per-item layout so the same announcement always lands at the
 *  same Y / speed / colour across reloads. */
function makeDanmuMsg(a: Announcement, idx: number): DanmuMsg {
  const colors = ["#60a5fa", "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#38bdf8", "#facc15"];
  const h = (Math.imul(idx + 1, 2654435761) >>> 0);
  return {
    id:     a.id,
    text:   a.text,
    y:      6 + (h % 72),
    speed:  35 + ((h >> 8) % 10),
    color:  colors[(h >> 4) % colors.length],
    delay:  -(((h >> 12) % 20)),
    author: formatAuthor(a) ?? "",
  };
}

// ── Banner props ────────────────────────────────────────────────────────────

export type AnnouncementBannerProps = {
  collapsed:    boolean;
  onCollapse:   () => void;
  onExpand:     () => void;
  /** Shared public ticker feed (newest-first) — comes from useAnnouncements. */
  announcements: Announcement[];
  msgInput:     string;
  setMsgInput:  (v: string) => void;
  /** True → the next send will be posted with author_email="anonymous"
   *  so the ticker renders "Anonymous User" instead of the signed name. */
  msgAnonymous: boolean;
  setMsgAnonymous: (v: boolean) => void;
  msgSending:   boolean;
  msgSentOk:    boolean;
  onSend:       () => void;
};

// ── Component ────────────────────────────────────────────────────────────────

export function AnnouncementBanner({
  collapsed, onCollapse, onExpand,
  announcements,
  msgInput, setMsgInput,
  msgAnonymous, setMsgAnonymous,
  msgSending, msgSentOk, onSend,
}: AnnouncementBannerProps) {
  // Hover pauses the rotation so users can read long messages without the
  // card advancing out from under them.
  const [hoverPaused, setHoverPaused] = useState(false);

  // Deterministic danmu payload — each Announcement always maps to the same
  // floating bullet position. Only recompute when the announcements array
  // identity changes.
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
        {/* Danmu — each message is its own absolutely-positioned span keyed
            by its announcement id. Adding a new message appends a new span
            without touching the existing ones, so earlier bullets keep
            their in-flight animation and never "jump". */}
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
                  top: `${msg.y}%`,
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
      {/* Rotator row — single-card, pause-on-hover. */}
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

/** Back-compat re-export — old imports of makeMsg expected the danmu factory. */
export { makeDanmuMsg as makeMsg };
