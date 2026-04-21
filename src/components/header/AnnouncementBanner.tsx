// ─────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — the thin strip at the top of the Workspace that
// carries the SHARED PUBLIC ticker.
//
// Every public message anyone posts lands in the announcements Supabase
// table, the trigger caps it at 50 rows, and every open tab gets the new
// row via Supabase Realtime (see src/lib/hooks/use-announcements.ts).
// The banner just renders whatever array the parent passes in — it has no
// opinion about where the data came from.
//
// Two display modes:
//   - Expanded  (default): horizontal marquee scrolling every announcement
//                          left-to-right, looped twice so the wrap is seamless.
//   - Collapsed: translucent strip where the same announcements float across
//                as bullet-comments (danmu-style), so users still get a
//                peripheral signal that activity is happening.
// ─────────────────────────────────────────────────────────────────────────────

import { Megaphone, MessageSquare, Check } from "lucide-react";
import type { Announcement } from "@/lib/hooks/use-announcements";

// ── Ticker ───────────────────────────────────────────────────────────────────

function TickerTrack({ items }: { items: Announcement[] }) {
  // Fallback copy — only shown when no announcements exist at all (fresh DB
  // before seed insert). The DDL seeds three welcome rows, so in practice
  // users should always see real content.
  const fallback: Announcement[] = items.length > 0 ? [] : [{
    id:           "fallback",
    author_email: "system",
    text:         "Welcome to AcademiCats — this is where team + user announcements scroll live.",
    created_at:   new Date().toISOString(),
  }];
  const list = items.length > 0 ? items : fallback;

  const segment = (
    <span className="inline-flex items-center gap-0">
      {list.map((item) => {
        const author = item.author_email && !item.author_email.includes("dev@")
          ? item.author_email.split("@")[0]
          : null;
        return (
          <span key={`${item.id}-${item.created_at}`} className="inline-block shrink-0 pr-16 text-xs leading-relaxed text-slate-300">
            {author && (
              <span className="mr-1 text-blue-400/80 font-semibold">{author}:</span>
            )}
            {item.text}
          </span>
        );
      })}
    </span>
  );
  // Speed scales loosely with payload length so bigger feeds don't zip by.
  const baseSecs = 24;
  const perItemSecs = 4;
  const duration = Math.max(baseSecs, Math.min(120, baseSecs + list.length * perItemSecs));
  return (
    // translate="no" — the marquee content is continuously re-composed by the
    // CSS keyframe; letting Google Translate rewrite its text nodes mid-flight
    // produces a "removeChild" DOM mismatch and crashes the tab.
    <div
      translate="no"
      className="notranslate flex overflow-hidden"
      style={{ maskImage: "linear-gradient(to right, transparent 0%, black 4%, black 96%, transparent 100%)" }}
    >
      <div
        className="flex shrink-0 whitespace-nowrap"
        style={{ animation: `ticker ${duration}s linear infinite` }}
      >
        {segment}{segment}
      </div>
    </div>
  );
}

// ── Danmu (bullet-comment) message shape ────────────────────────────────────

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
 *  same Y/speed/colour — important for the feed to feel stable across reloads. */
function makeDanmuMsg(a: Announcement, idx: number): DanmuMsg {
  const colors = ["#60a5fa", "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#38bdf8", "#facc15"];
  const h = (Math.imul(idx + 1, 2654435761) >>> 0);
  return {
    id:    a.id,
    text:  a.text,
    y:     6 + (h % 72),
    speed: 35 + ((h >> 8) % 10),
    color: colors[(h >> 4) % colors.length],
    delay: -(((h >> 12) % 20)),
    author: a.author_email && !a.author_email.includes("dev@")
      ? a.author_email.split("@")[0]
      : "",
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
  msgPublic:    boolean;
  setMsgPublic: (v: boolean) => void;
  msgSending:   boolean;
  msgSentOk:    boolean;
  onSend:       () => void;
};

// ── Component ────────────────────────────────────────────────────────────────

export function AnnouncementBanner({
  collapsed, onCollapse, onExpand,
  announcements,
  msgInput, setMsgInput,
  msgPublic, setMsgPublic,
  msgSending, msgSentOk, onSend,
}: AnnouncementBannerProps) {
  const danmu = announcements.map((a, idx) => makeDanmuMsg(a, idx));

  if (collapsed) {
    return (
      <div className="h-full rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)] overflow-hidden flex flex-col">
        <div className="flex items-center gap-2 px-3 pr-10 shrink-0" style={{ height: "20px" }}>
          <span className="megaphone-breath shrink-0 flex items-center justify-center">
            <Megaphone size={11} className="shrink-0 text-blue-400/60" />
          </span>
          <div className="flex-1 h-px bg-gradient-to-r from-blue-500/25 via-purple-500/20 to-blue-500/25" />
          <button
            onClick={onExpand}
            title="Expand announcements"
            aria-label="Expand announcements"
            className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-[10px] text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 transition select-none"
          >▼</button>
        </div>
        {/* Danmu area — translate="no" because each message is continuously
            re-rendered via a keyframe; Google Translate rewriting text nodes
            mid-flight produces a DOM mismatch crash. */}
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
    <div className="h-full flex flex-col justify-between overflow-hidden rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)]">
      {/* Ticker row */}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 pr-10">
        <span className="megaphone-breath shrink-0 flex items-center justify-center">
          <Megaphone size={13} className="shrink-0 text-blue-400/70" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <TickerTrack items={announcements} />
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
          onClick={() => setMsgPublic(!msgPublic)}
          title={msgPublic ? "Public — will broadcast to the live ticker" : "Private — only emailed to the developer"}
          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide transition select-none ${
            msgPublic
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
              : "bg-slate-700/30 text-slate-500 border border-slate-700/40"
          }`}
        >
          {msgPublic ? "PUBLIC" : "PRIVATE"}
        </button>
        <MessageSquare size={11} className="shrink-0 text-slate-600" />
        <input
          type="text"
          value={msgInput}
          onChange={(e) => setMsgInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !msgSending) void onSend(); }}
          placeholder={msgPublic ? "Broadcast to every open tab…" : "Send a private note to the team…"}
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

/** Back-compat re-export — old imports of makeMsg expected a plain text factory. */
export { makeDanmuMsg as makeMsg };
