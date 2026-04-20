// ─────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — the thin strip at the top of the Workspace that
// carries the developer's ticker + lets users drop a message back.
//
// Extracted out of src/app/page.tsx so the 4800-line god-component keeps
// shrinking. The banner has three moving parts:
//   - TickerTrack   — continuously scrolling dev copy (translate="no" so
//                     Google Translate doesn't fight the keyframe animation).
//   - DanmuMsg / makeMsg — bullet-comment shape + deterministic factory.
//   - AnnouncementBanner — the visible component, rendered in two modes
//                     (collapsed: thin bar with danmu only; expanded: ticker
//                     + message input row).
// The parent owns message state and the send handler; the banner is purely
// presentational so it re-renders only when props actually change.
// ─────────────────────────────────────────────────────────────────────────────

import { Megaphone, MessageSquare, Check } from "lucide-react";

// ── Ticker ───────────────────────────────────────────────────────────────────

const TICKER_ITEMS: React.ReactNode[] = [
  <>👋 Hi everyone! I&apos;m Zest, the developer. Together with my team β lyrea, we built AcademiCats to empower researchers. 🐾</>,
  <>🎯 Our goal is to improve efficiency and output quality throughout the academic research process — from literature discovery to deep analysis. 📚</>,
  <>💌 Feedback is always welcome! Email <a href="mailto:jy1529098645@gmail.com" className="underline underline-offset-2 decoration-blue-400/60 text-blue-400 hover:text-blue-300 transition-colors">jy1529098645@gmail.com</a> or drop a note below. Thank you! 🙏</>,
];

function TickerTrack() {
  const segment = (
    <span className="inline-flex items-center gap-0">
      {TICKER_ITEMS.map((item, i) => (
        <span key={i} className="inline-block shrink-0 pr-16 text-xs leading-relaxed text-slate-300">
          {item}
        </span>
      ))}
    </span>
  );
  return (
    // translate="no" — the ticker is continuously re-composed by a CSS
    // keyframe; letting Google Translate rewrite its text nodes mid-flight
    // produces a "removeChild" DOM mismatch and crashes the tab.
    <div
      translate="no"
      className="notranslate flex overflow-hidden"
      style={{ maskImage: "linear-gradient(to right, transparent 0%, black 4%, black 96%, transparent 100%)" }}
    >
      <div
        className="flex shrink-0 whitespace-nowrap"
        style={{ animation: "ticker 38s linear infinite" }}
      >
        {segment}{segment}
      </div>
    </div>
  );
}

// ── Danmu (bullet-comment) message shape ────────────────────────────────────

export type DanmuMsg = {
  id: string;
  text: string;
  y: number;
  speed: number;
  delay: number;
  color: string;
};

/**
 * Deterministic per-index layout so the same message text always lands at the
 * same Y/speed/colour — important for the list to feel stable when the user
 * refreshes or the publicMsgs array re-indexes after a trim.
 */
export function makeMsg(text: string, idx: number): DanmuMsg {
  const colors = ["#60a5fa", "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#38bdf8", "#facc15"];
  const h = (Math.imul(idx + 1, 2654435761) >>> 0);
  return {
    id: `msg-${idx}-${Date.now()}`,
    text,
    y: 6 + (h % 72),                 // 6 % – 78 % vertical
    speed: 35 + ((h >> 8) % 10),     // 35 s – 45 s
    color: colors[(h >> 4) % colors.length],
    delay: -(((h >> 12) % 20)),      // stagger starting positions
  };
}

// ── Banner props ────────────────────────────────────────────────────────────

export type AnnouncementBannerProps = {
  collapsed:   boolean;
  onCollapse:  () => void;
  onExpand:    () => void;
  publicMsgs:  DanmuMsg[];
  msgInput:    string;
  setMsgInput: (v: string) => void;
  msgPublic:   boolean;
  setMsgPublic:(v: boolean) => void;
  msgSending:  boolean;
  msgSentOk:   boolean;
  onSend:      () => void;
};

// ── Component ────────────────────────────────────────────────────────────────

export function AnnouncementBanner({
  collapsed, onCollapse, onExpand,
  publicMsgs,
  msgInput, setMsgInput,
  msgPublic, setMsgPublic,
  msgSending, msgSentOk, onSend,
}: AnnouncementBannerProps) {
  if (collapsed) {
    return (
      <div className="h-full rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)] overflow-hidden flex flex-col">
        <div className="flex items-center gap-2 px-3 pr-10 shrink-0" style={{ height: "20px" }}>
          <Megaphone size={11} className="shrink-0 text-blue-400/60" />
          <div className="flex-1 h-px bg-gradient-to-r from-blue-500/25 via-purple-500/20 to-blue-500/25" />
          <button
            onClick={onExpand}
            title="Expand announcements"
            className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-[10px] text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 transition select-none"
          >▼</button>
        </div>
        {/* Danmu area — translate="no" because each message is continuously
            re-rendered via a keyframe; Google Translate rewriting text nodes
            mid-flight produces a DOM mismatch crash. */}
        <div translate="no" className="notranslate relative flex-1 overflow-hidden">
          {publicMsgs.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-600 opacity-50 select-none pointer-events-none">
              Public messages will flow here as danmu ✦
            </div>
          ) : (
            publicMsgs.map((msg) => (
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
        <Megaphone size={13} className="shrink-0 text-blue-400/70" />
        <div className="min-w-0 flex-1 overflow-hidden">
          <TickerTrack />
        </div>
        <button
          onClick={onCollapse}
          title="Collapse announcements"
          className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-[10px] text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 transition select-none"
        >▲</button>
      </div>

      {/* Message input row */}
      <div className="flex items-center gap-1.5 border-t border-slate-800/50 px-3 py-1.5">
        <button
          onClick={() => setMsgPublic(!msgPublic)}
          title={msgPublic ? "Public — will appear as danmu" : "Private — only emailed to developer"}
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
          placeholder="Leave a message for the team…"
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
