// ─────────────────────────────────────────────────────────────────────────────
// AnnouncementBanner — shared public ticker with two visual modes.
//
// Layout:
//   ┌─ Control strip ──────────────────────────────┐   ← thin, outside the card
//   │  ‹ ● ○ ○ ○ ○ ›  ✦                            │   (toggle swaps board↔danmu)
//   └──────────────────────────────────────────────┘
//   ┌─ Banner card ────────────────────────────────┐
//   │  [📣] author · message text …                 │   ← board mode row 1
//   ├──────────────────────────────────────────────┤
//   │  [🔒 SIGNED | 🕶 ANON] ✉️ input …  [Send]     │   ← board mode row 2
//   └──────────────────────────────────────────────┘
//
// Board mode (default):
//   - Row 1 is the rotator. If the current message's single-line width
//     exceeds the container width, it switches into a looping left-right
//     marquee (see `ann-marquee` in globals.css). Short messages render
//     as a normal truncated line — no animation.
//   - Row 2 is the composer (signed/anon toggle, input, send).
//
// Danmu-board mode (toggled via the ✦ button):
//   - The card keeps its border and dimensions.
//   - Rotator row, composer row, divider, and megaphone overlay are
//     ALL hidden — only the danmu animation plays inside the otherwise-
//     empty card frame. Matches the user's spec "keep only the banner's
//     border, hide other content, show danmu".
//
// Banner size is fixed between modes. The parent's flex-1 + min-h-0
// gives both modes identical outer dimensions.
//
// Composer toggle: SIGNED / ANONYMOUS is rendered as a two-option
// segmented switch so the affordance is obvious — previously a single
// label-swap button confused users who didn't realise it was clickable.
//
// Theme coupling: every interactive colour reads from --ats-* tokens so
// every theme tints without extra classes.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Megaphone, MessageSquare, Check, ChevronLeft, ChevronRight, Sparkles, ThumbsUp, ThumbsDown } from "lucide-react";
import type { Announcement } from "@/lib/hooks/use-announcements";
import { usePrefsStore } from "@/lib/stores/prefs-store";

const DOT_LIMIT = 10;

function formatAuthor(a: Announcement): string | null {
  const email = (a.author_email || "").toLowerCase();
  // Anonymous posts land with author_email="" from the backend (see the
  // POST /api/announcements handler). Render them under a playful
  // "Nameless Cat" handle — fits the AcademiCats branding and makes
  // anonymity feel intentional rather than sketchy. "Anonymous User"
  // was the old copy; several users asked for something lighter.
  if (!email || email === "anonymous" || email.startsWith("anonymous@")) {
    return "Nameless Cat";
  }
  if (email.includes("dev@")) return null;
  return email.split("@")[0];
}

// ── Board-mode rotator with marquee overflow ────────────────────────────────
// The rotator renders the current announcement on a single line. If the
// rendered text width exceeds the available container width, the
// AnnouncementText sub-component switches into a left-right looping
// marquee — this matches the user's spec "banner size is fixed; long
// messages scroll horizontally like the original ticker". Short messages
// render as a normal truncated line so there's no pointless motion.

function AnnouncementRotatorCard({
  items,
  paused,
  idx,
  onVote,
}: {
  items: Announcement[];
  paused: boolean;
  idx: number;
  /** Click handler for the like / dislike buttons. Caller owns toggle
   *  semantics: second click with the same vote should pass null to
   *  clear. */
  onVote: (id: string, vote: "up" | "down" | null) => void;
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
  // Google Translate IS allowed here. Previous revisions had translate="no"
  // to protect volatile DOM from Google's text-node rewrite, but the
  // rotator remounts on every cycle (key={current.id}) — each new
  // message is a fresh DOM subtree, so there's no React-owned node for
  // Google to collide with. Users on a translated page will see their
  // message content translated (including the "Nameless Cat" byline),
  // which is the behaviour they asked for.
  return (
    <div
      key={current.id}
      className="ticker-fade-in flex items-center gap-2 min-w-0 w-full"
      aria-live={paused ? "off" : "polite"}
    >
      {author && (
        <span
          className="shrink-0 text-[10px] font-bold uppercase tracking-wide"
          style={{ color: "var(--ats-fg-accent)" }}
        >
          {author}
        </span>
      )}
      <AnnouncementText text={current.text} paused={paused} />
      <VoteButtons
        likeCount={current.like_count ?? 0}
        dislikeCount={current.dislike_count ?? 0}
        myVote={current.my_vote ?? null}
        onClick={(next) => onVote(current.id, next)}
      />
    </div>
  );
}

// Thumbs-up / thumbs-down pair shown at the right end of each rotator
// row. `shrink-0` so long text marquees next to them without pushing
// them off screen. Active state uses --ats-fg-accent for "up" (positive)
// and a neutral red for "down" so the distinction is colour-coded.
function VoteButtons({
  likeCount, dislikeCount, myVote, onClick,
}: {
  likeCount:    number;
  dislikeCount: number;
  myVote:       "up" | "down" | null;
  onClick:      (next: "up" | "down" | null) => void;
}) {
  const base = "inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold transition-colors select-none";
  return (
    <div className="shrink-0 flex items-center gap-0.5 ml-1">
      <button
        onClick={(e) => { e.stopPropagation(); onClick(myVote === "up" ? null : "up"); }}
        title={myVote === "up" ? "Remove your like" : "Like this announcement"}
        className={base}
        style={{
          color:           myVote === "up" ? "var(--ats-fg-accent)" : "var(--ats-fg-muted)",
          backgroundColor: myVote === "up" ? "var(--ats-bg-accent-soft)" : "transparent",
        }}
      >
        <ThumbsUp size={11} />
        {likeCount > 0 && <span className="tabular-nums">{likeCount}</span>}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onClick(myVote === "down" ? null : "down"); }}
        title={myVote === "down" ? "Remove your dislike" : "Dislike this announcement"}
        className={base}
        style={{
          color:           myVote === "down" ? "#f87171" : "var(--ats-fg-muted)",
          backgroundColor: myVote === "down" ? "rgba(248, 113, 113, 0.12)" : "transparent",
        }}
      >
        <ThumbsDown size={11} />
        {dislikeCount > 0 && <span className="tabular-nums">{dislikeCount}</span>}
      </button>
    </div>
  );
}

// Measures the raw (non-wrapped) width of `text` against its container
// and flips into a marquee render only when the text truly overflows.
// Hidden measurement span mirrors the visible text's typography so the
// overflow check matches the final rendered layout exactly.

function AnnouncementText({ text, paused }: { text: string; paused: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef   = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const c = containerRef.current;
    const m = measureRef.current;
    if (!c || !m) return;
    const check = () => {
      // 4px tolerance — avoids flicker when scrollWidth and clientWidth
      // are within a sub-pixel rounding of each other.
      setOverflow(m.scrollWidth > c.clientWidth + 4);
    };
    check();
    // Re-check on container resize (window resize, sibling panel
    // toggle, etc). ResizeObserver is available in every browser we
    // target; no polyfill needed.
    const ro = new ResizeObserver(check);
    ro.observe(c);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1 overflow-hidden">
      {/* Hidden measurement span — same typography as the visible text,
          forced single-line, rendered absolutely so it doesn't occupy
          layout space. The visible text below swaps between truncate
          and marquee depending on the `overflow` state. */}
      <span
        ref={measureRef}
        aria-hidden
        className="absolute invisible whitespace-nowrap text-xs leading-snug"
        style={{ pointerEvents: "none" }}
      >
        {text}
      </span>

      {overflow ? (
        <div
          className="ann-marquee flex items-center whitespace-nowrap text-xs leading-snug text-slate-300"
          data-paused={paused ? "true" : "false"}
        >
          {/* Two copies of the text + two bullet separators, all in a
              single inline-flex strip. Because -50% of the strip's
              width is exactly one [text + bullet] unit, translating by
              -50% lands the second copy where the first copy started →
              visually seamless loop. */}
          <span>{text}</span>
          <span className="px-8 opacity-40" aria-hidden>•</span>
          <span aria-hidden>{text}</span>
          <span className="px-8 opacity-40" aria-hidden>•</span>
        </div>
      ) : (
        <span className="block text-xs leading-snug text-slate-300 truncate">
          {text}
        </span>
      )}
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
  paused,
}: {
  count: number;
  idx: number;
  setIdx: (n: number) => void;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  paused: boolean;
}) {
  const safeIdx = count > 0 ? idx % count : 0;
  const useDots = count > 1 && count <= DOT_LIMIT;
  const prev = () => { if (count > 0) setIdx((safeIdx - 1 + count) % count); };
  const next = () => { if (count > 0) setIdx((safeIdx + 1) % count); };

  return (
    // All chrome is left-aligned, NO ml-auto push, so the mode toggle
    // sits flush against the rotator nav. Nav chrome (prev/next + dots)
    // is rendered in BOTH board and danmu modes so that toggling
    // between them doesn't cause a layout reflow — the control strip
    // stays visually identical, only the banner body below changes.
    // In danmu mode the arrows still work (they advance `idx`, which
    // the board mode will honour on return) even though no rotator is
    // currently visible.
    <div className="shrink-0 flex items-center gap-1 px-1" style={{ height: "18px" }}>
      {/* Nav chrome — always rendered when there are multiple items, so
          the strip's layout is stable when switching modes. Slightly
          dimmed in danmu mode (they don't visibly rotate anything) but
          still functional so returning to board mode remembers the idx. */}
      {count > 1 && (
        <div
          className="flex items-center gap-1 transition-opacity duration-200"
          style={{ opacity: collapsed ? 0.5 : (paused ? 0.65 : 1) }}
          title={paused && !collapsed ? "Paused — move mouse off to resume" : undefined}
        >
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
        </div>
      )}
      {/* Mode toggle — ALWAYS present, never repositions. Flips between
          "announcement board" and "danmu board" modes. `collapsed` was
          the historical name for danmu mode; the prop is kept stable
          so page.tsx doesn't need changing. Icon is Sparkles when
          board-mode is active (click to enter danmu), Megaphone when
          danmu-mode is active (click to come back). */}
      <button
        onClick={collapsed ? onExpand : onCollapse}
        title={collapsed ? "Show announcement board" : "Switch to danmu board"}
        aria-label={collapsed ? "Switch to announcement board" : "Switch to danmu board"}
        className="shrink-0 flex h-4 w-4 items-center justify-center rounded text-slate-500 hover:text-[var(--ats-fg-accent)] hover:bg-[var(--ats-bg-accent-soft)] transition-colors select-none"
      >
        {collapsed ? <Megaphone size={10} /> : <Sparkles size={10} />}
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
  /** Theme toggle integrated into the banner's top-right corner. The
   *  button used to live outside the card (absolutely positioned in
   *  page.tsx); moving it inside here makes the affordance read as
   *  "part of the banner chrome" instead of a floating control. */
  themeMode:    "day" | "night";
  onToggleTheme:() => void;
  /** Like / dislike vote for the current rotator announcement. Caller
   *  owns toggle semantics (pass null to clear). Forwards the click to
   *  useAnnouncements().vote which handles the optimistic update + API. */
  onVote:       (id: string, vote: "up" | "down" | null) => void;
};

// Email of the seeded dev author — rows with this author_email are the
// three system announcements. Danmu mode filters these OUT so only
// real user posts flow across the screen (seed messages are still in
// the rotator board, just not bouncing around as danmu).
const DEV_SEED_EMAIL = "dev@academicats.com";

export function AnnouncementBanner({
  collapsed, onCollapse, onExpand,
  announcements,
  msgInput, setMsgInput,
  msgAnonymous, setMsgAnonymous,
  msgSending, msgSentOk, onSend,
  themeMode, onToggleTheme,
  onVote,
}: AnnouncementBannerProps) {
  const [hoverPaused, setHoverPaused] = useState(false);
  const [idx, setIdx] = useState(0);
  const count = announcements.length;

  // Rotate interval is user-tunable via Settings → Behaviour → Announcement
  // rotation. Pulls from the shared prefs store so a slider change takes
  // effect on the next interval tick (re-subscribes the effect).
  const rotatorIntervalMs = usePrefsStore(s => s.rotatorIntervalMs);

  // Auto-advance. Pauses when the user hovers the banner OR when the feed
  // has at most one item (nothing to rotate through).
  useEffect(() => {
    if (collapsed || hoverPaused || count <= 1) return;
    const id = window.setInterval(() => setIdx(i => (i + 1) % count), rotatorIntervalMs);
    return () => window.clearInterval(id);
  }, [collapsed, hoverPaused, count, rotatorIntervalMs]);

  // Jump to the newest message whenever the head of the list changes.
  // The announcements feed (useAnnouncements hook) prepends new rows —
  // both from local optimistic posts and from Realtime INSERT events —
  // so `announcements[0].id` changing means someone (possibly the user
  // themselves) just posted. We snap idx back to 0 so the rotator
  // shows the fresh content immediately instead of waiting up to 6s
  // for the auto-advance to cycle around.
  //
  // Guard with a ref against the first render / empty-feed transitions,
  // otherwise the effect would "jump to latest" on initial mount and
  // cause the auto-advance to feel reset every time the feed hydrates.
  const prevHeadIdRef = useRef<string | null>(null);
  useEffect(() => {
    const headId = announcements[0]?.id ?? null;
    const prev = prevHeadIdRef.current;
    prevHeadIdRef.current = headId;
    // Only jump if we had a previous head AND it actually changed.
    // This skips the first-ever render and feed-hydration paints.
    if (prev !== null && headId !== null && prev !== headId) {
      setIdx(0);
    }
  }, [announcements]);

  // Stable danmu payload — derived from user-posted rows only. Seed
  // messages (author_email = DEV_SEED_EMAIL) are the "system welcome"
  // posts and should stay in the rotator board but NOT bounce around
  // as danmu — mixing them in made the danmu view feel spammy.
  // A string key ensures the list only recomputes when the underlying
  // user-posted rows actually change, so in-flight CSS animations keep
  // their timing across unrelated re-renders (e.g. hover state).
  const userMessages = useMemo(
    () => announcements.filter(a => a.author_email !== DEV_SEED_EMAIL),
    [announcements],
  );
  const danmuKey = userMessages.map(a => a.id).join("|");
  const danmu = useMemo(
    () => userMessages.map((a, i) => makeDanmuMsg(a, i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [danmuKey],
  );

  return (
    <div
      className="h-full flex flex-col gap-1"
      onMouseEnter={() => setHoverPaused(true)}
      onMouseLeave={() => setHoverPaused(false)}
    >
      {/* CONTROL STRIP — lives outside the card, doesn't eat banner space.
          `paused` drives the dim-on-hover feedback so the user knows the
          rotator is frozen while their cursor is over the banner. */}
      <ControlStrip
        count={count}
        idx={idx}
        setIdx={setIdx}
        collapsed={collapsed}
        onCollapse={onCollapse}
        onExpand={onExpand}
        paused={hoverPaused}
      />

      {/* BANNER CARD — the board-mode structure (rotator + composer) is
          ALWAYS mounted so the card's natural height is identical in
          both modes. When `collapsed` is true the board structure is
          hidden via `invisible` (still takes layout space, just not
          painted / not interactive) and the danmu layer is laid over
          the top via absolute positioning. This means switching to
          danmu mode doesn't trigger a height change on the card — the
          parent flex row (mascot + banner) stays anchored and nothing
          around the banner reflows. */}
      <div className="relative flex-1 min-h-0 overflow-hidden rounded-2xl border border-blue-500/15 bg-[var(--ats-bg-panel)]">
        {/* Integrated theme toggle — lives inside the card chrome at the
            right end of the top row. z-20 keeps it above the danmu
            overlay when collapsed. */}
        <ThemeToggleButton mode={themeMode} onToggle={onToggleTheme} />

        {/* ── Board-mode structure ───────────────────────────────────
            Always mounted; only its visibility flips. `invisible` keeps
            the rows in layout flow (so they contribute their natural
            height to the card) but removes them from paint + the
            accessibility tree, and blocks pointer events so typing /
            sending isn't possible while in danmu mode. */}
        <div
          className={`h-full flex flex-col justify-between ${collapsed ? "invisible" : ""}`}
          aria-hidden={collapsed}
        >
          {/* Row 1 — rotator (marquees when text overflows). Right
              padding reserves space for the theme toggle so long
              messages don't slide under it. Hover-pause is signalled
              two ways: (1) the megaphone swaps to a pause glyph, and
              (2) a subtle "Paused" pill fades in on the left so the
              user can't miss that the rotator is actually frozen. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 pr-10">
            <span
              className={`shrink-0 flex items-center justify-center transition-all duration-200 ${hoverPaused ? "" : "megaphone-breath"}`}
              title={hoverPaused ? "Paused — move mouse away to resume rotation" : undefined}
            >
              {hoverPaused
                ? <PauseGlyph color="var(--ats-fg-accent)" />
                : <Megaphone size={13} style={{ color: "var(--ats-fg-accent)", opacity: 0.85 }} />}
            </span>
            <div className="min-w-0 flex-1 overflow-hidden">
              <AnnouncementRotatorCard items={announcements} paused={hoverPaused} idx={idx} onVote={onVote} />
            </div>
          </div>
          {/* Row 2 — composer */}
          <div className="flex items-center gap-1.5 border-t border-slate-800/50 px-3 py-1.5">
            <SignedAnonymousToggle value={msgAnonymous} onChange={setMsgAnonymous} />
            <MessageSquare size={11} className="shrink-0 text-slate-600" />
            <input
              type="text"
              value={msgInput}
              onChange={(e) => setMsgInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !msgSending) void onSend(); }}
              placeholder={msgAnonymous
                ? "Broadcast anonymously — your email won't appear"
                : "Broadcast as your account — visible to everyone"}
              maxLength={280}
              tabIndex={collapsed ? -1 : 0}
              className="min-w-0 flex-1 bg-transparent py-0.5 text-xs text-slate-300 outline-none placeholder:text-slate-700"
            />
            <button
              onClick={() => void onSend()}
              disabled={!msgInput.trim() || msgSending}
              tabIndex={collapsed ? -1 : 0}
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

        {/* ── Danmu overlay ───────────────────────────────────────────
            Only painted when collapsed. Absolute-positioned so it
            floats over the hidden board structure without adding any
            height of its own. `pointer-events-none` so the danmu
            bullets never intercept clicks the board might need later
            if we ever re-enable interactivity in danmu mode. */}
        {collapsed && (
          <div translate="no" className="notranslate absolute inset-0 overflow-hidden pointer-events-none">
            {danmu.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-600 opacity-50 select-none">
                User posts will flow here as danmu ✦
              </div>
            ) : (
              danmu.map((msg) => (
                <span
                  key={msg.id}
                  className="absolute whitespace-nowrap text-[11px] font-medium select-none"
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
        )}
      </div>
    </div>
  );
}

// ── Integrated theme toggle (Day ↔ Night) ───────────────────────────────────
// Lives inside the banner card at the top-right. Previously the toggle
// floated outside the banner (absolute negative offsets); moving it in
// here makes it read as part of the banner's chrome — users no longer
// have to mentally separate "banner control" from "page-level control".

function ThemeToggleButton({ mode, onToggle }: { mode: "day" | "night"; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={mode === "night" ? "Switch to Day theme" : "Switch to Night theme"}
      aria-label={mode === "night" ? "Switch to day theme" : "Switch to night theme"}
      className="absolute top-1.5 right-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-full border transition-all duration-200 hover:brightness-110"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-accent-soft)",
        color:           "var(--ats-fg-accent)",
      }}
    >
      {mode === "night" ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5"/>
          <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      )}
    </button>
  );
}

// ── Signed / Anonymous segmented toggle ─────────────────────────────────────
// Previous implementation was a single-label button that flipped between
// "SIGNED" and "ANONYMOUS" — nothing about it read as clickable, so users
// didn't realise they could post privately. This segmented control shows
// BOTH options at once, with the active choice filled and the inactive one
// dim-but-clearly-hoverable. Icons reinforce the semantics (lock = identity,
// incognito = no identity).

function SignedAnonymousToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  // `value === true` means anonymous. Active pill uses the theme's accent
  // tokens (--ats-bg-accent-soft / --ats-fg-accent / --ats-border-accent)
  // so the toggle adopts the current palette — emerald on Morning Mint,
  // amber on Warm Paper, blue on Daylight Blue, etc. — instead of a
  // fixed emerald. Inactive state uses --ats-fg-muted for text.
  const activeStyle: React.CSSProperties = {
    backgroundColor: "var(--ats-bg-accent-soft)",
    color:           "var(--ats-fg-accent)",
    borderColor:     "var(--ats-border-accent)",
  };
  const inactiveStyle: React.CSSProperties = {
    color:       "var(--ats-fg-muted)",
    borderColor: "transparent",
  };
  return (
    <div
      role="radiogroup"
      aria-label="Post visibility"
      className="shrink-0 inline-flex items-center rounded-md border p-0.5 text-[9px] font-bold tracking-wide select-none"
      style={{
        borderColor:     "var(--ats-border-subtle)",
        backgroundColor: "var(--ats-bg-panel)",
      }}
    >
      <button
        role="radio"
        aria-checked={!value}
        onClick={() => onChange(false)}
        title="Post signed — your email will show on the ticker"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors hover:brightness-110"
        style={!value ? activeStyle : inactiveStyle}
      >
        <LockIcon />
        SIGNED
      </button>
      <button
        role="radio"
        aria-checked={value}
        onClick={() => onChange(true)}
        title="Post anonymously — your email will not appear"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors hover:brightness-110"
        style={value ? activeStyle : inactiveStyle}
      >
        <MaskIcon />
        ANON
      </button>
    </div>
  );
}

// Small ‖ pause glyph — used in the rotator megaphone slot while the user
// hovers to make the pause state feel intentional rather than accidental.
function PauseGlyph({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="6"  y="4" width="4" height="16" rx="1" fill={color} opacity={0.85} />
      <rect x="14" y="4" width="4" height="16" rx="1" fill={color} opacity={0.85} />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function MaskIcon() {
  // Simple "masked face" glyph — two eye-slits over an oval — reads as
  // disguise / privacy without pulling a new lucide import.
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <line x1="7" y1="11" x2="10" y2="11" />
      <line x1="14" y1="11" x2="17" y2="11" />
      <path d="M8.5 16c1 1 2 1.5 3.5 1.5S14 17 15.5 16" />
    </svg>
  );
}

export { makeDanmuMsg as makeMsg };
