// ─────────────────────────────────────────────────────────────────────────────
// UserNotificationPopup — renders the top pending dev-to-user message as a
// modal. Matches the house modal style: rounded-2xl panel with --ats-* CSS
// variables, centred overlay, backdrop dismiss, X close. Kind-specific accent
// keeps tier-upgrade / quota-grant visually distinct without shouting.
//
// Lifecycle: pops the first item in `queue`; on close, calls ack(id) to stamp
// seen_at server-side AND drop it from the local queue. The next item (if
// any) surfaces on the next render.
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { memo, useEffect, useState } from "react";
import type { UserNotification } from "@/lib/hooks/use-user-notifications";

type Props = {
  queue: UserNotification[];
  ack:   (id: string) => Promise<void>;
};

// memo'd because the parent page re-renders on every keystroke / panel
// toggle / search progress chunk, but this popup only actually changes
// when the queue array reference changes (new notification arrives or
// the user dismisses one). `ack` from useUserNotifications is wrapped
// in useCallback so its reference is stable. Default shallow compare
// is enough — saves a re-render of the modal's JSX on every parent
// churn even when the popup isn't displayed.
function UserNotificationPopupImpl({ queue, ack }: Props) {
  const [closing, setClosing] = useState(false);

  // ESC dismiss.
  useEffect(() => {
    if (queue.length === 0) return;
    const top = queue[0];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void handleClose(top.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  if (queue.length === 0) return null;
  const n = queue[0];

  const handleClose = async (id: string) => {
    if (closing) return;
    setClosing(true);
    try { await ack(id); }
    finally { setClosing(false); }
  };

  // Kind → accent colour for the top bar. Keeps each category visually
  // distinct without leaving the product palette.
  const kindAccent = (() => {
    switch (n.kind) {
      case "tier_upgrade": return "#8b5cf6"; // violet — "upgrade"
      case "quota_grant":  return "#10b981"; // emerald — "gift"
      case "system":       return "#64748b"; // slate — neutral admin
      default:             return "var(--ats-border-accent)";
    }
  })();

  const kindLabel = (() => {
    switch (n.kind) {
      case "tier_upgrade": return "Tier upgrade";
      case "quota_grant":  return "Bonus added";
      case "system":       return "System";
      default:             return "Message from the team";
    }
  })();

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm"
      onClick={() => void handleClose(n.id)}
    >
      <div
        className="w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden"
        style={{
          borderColor:     "var(--ats-border-subtle)",
          backgroundColor: "var(--ats-bg-panel)",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-notif-title"
      >
        <div
          className="h-1 w-full"
          style={{ backgroundColor: kindAccent }}
        />
        <div className="px-6 pt-5 pb-3">
          <p
            className="text-[10px] font-semibold uppercase tracking-wider mb-2"
            style={{ color: "var(--ats-fg-muted)" }}
          >
            {kindLabel}
          </p>
          <div className="flex items-start gap-3">
            {n.emoji && (
              <span className="text-3xl leading-none shrink-0 select-none" aria-hidden>
                {n.emoji}
              </span>
            )}
            <div className="flex-1 min-w-0">
              {n.title && (
                <h2
                  id="user-notif-title"
                  className="text-lg font-bold leading-snug"
                  style={{ color: "var(--ats-fg-primary)" }}
                >
                  {n.title}
                </h2>
              )}
              {n.body && (
                <p
                  className="mt-1.5 text-sm whitespace-pre-wrap leading-relaxed"
                  style={{ color: "var(--ats-fg-secondary)" }}
                >
                  {n.body}
                </p>
              )}
            </div>
          </div>
        </div>
        <div
          className="flex items-center justify-between gap-3 px-6 py-3 border-t"
          style={{ borderColor: "var(--ats-border-subtle)" }}
        >
          <span className="text-[11px]" style={{ color: "var(--ats-fg-muted)" }}>
            {queue.length > 1 ? `+${queue.length - 1} more after this` : "From the team"}
          </span>
          <button
            onClick={() => void handleClose(n.id)}
            disabled={closing}
            className="rounded-lg border px-4 py-1.5 text-sm font-semibold transition-colors disabled:opacity-60"
            style={{
              borderColor:     "var(--ats-border-accent)",
              backgroundColor: "var(--ats-bg-accent-soft)",
              color:           "var(--ats-fg-accent)",
            }}
          >
            {closing ? "Closing…" : "Got it"}
          </button>
        </div>
      </div>
    </div>
  );
}

const UserNotificationPopup = memo(UserNotificationPopupImpl);
export default UserNotificationPopup;
