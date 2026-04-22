// ─────────────────────────────────────────────────────────────────────────────
// useUserNotifications — polls for developer-sent popup notifications.
//
// Sibling of useAnnouncements (global ticker), but for per-user targeted
// messages composed in the admin panel:
//   • Admin bumps user's tier     → writes a row into user_notifications
//   • Admin grants bonus quota    → writes a row
//   • Admin sends a free-form note → writes a row
//   → user's browser picks it up on next poll and shows a modal.
//
// Deliberate design choices:
//   • Simple polling, no realtime subscription. Volume is low (≤ a few per
//     user per day) and the window-focus refresh covers the "just came back
//     to the tab" case. Skips a Supabase-channel dependency.
//   • Returns an ORDERED queue; the UI pops the top one, acks it, then the
//     next one auto-surfaces on the following render.
//   • `ack(id)` removes the row locally AND fires POST /notifications/:id/ack
//     in the background. The local-remove gives instant UI feedback; the
//     server write stamps seen_at so we never show it again.
//   • Never throws. Anonymous callers short-circuit before any fetch.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { buildApiUrl, fetchWithAuth } from "@/lib/api";

export type UserNotification = {
  id:            string;
  user_id:       string;
  title:         string;
  body:          string;
  emoji:         string;
  kind:          "general" | "tier_upgrade" | "quota_grant" | "system" | string;
  author_email?: string;
  meta?:         Record<string, unknown>;
  created_at:    string;
};

export type UserNotificationsState = {
  queue:   UserNotification[];
  loading: boolean;
  error:   string;
  refresh: () => Promise<void>;
  ack:     (id: string) => Promise<void>;
};

const POLL_INTERVAL_MS = 60_000;  // every 60 s — low volume, no realtime dependency

export function useUserNotifications(isAuthed: boolean): UserNotificationsState {
  const [queue,   setQueue]   = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const mountedRef = useRef(true);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const refresh = useCallback(async () => {
    if (!isAuthed) { setQueue([]); return; }
    setLoading(true);
    try {
      const res = await fetchWithAuth(buildApiUrl("/api/me/notifications/unseen"));
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json() as { notifications?: UserNotification[] };
      if (!mountedRef.current) return;
      setError("");
      setQueue(Array.isArray(data.notifications) ? data.notifications : []);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [isAuthed]);

  const ack = useCallback(async (id: string) => {
    // Local optimistic drop — the modal closes instantly even if the network
    // is slow. The server write stamps seen_at so the row doesn't re-surface
    // if we refetch before the write lands.
    setQueue(prev => prev.filter(n => n.id !== id));
    try {
      await fetchWithAuth(buildApiUrl(`/api/me/notifications/${encodeURIComponent(id)}/ack`), {
        method: "POST",
      });
    } catch {
      // Swallow — if the ack POST fails the next refresh will re-surface
      // the row, which is the correct behaviour (we haven't really acked).
    }
  }, []);

  // Initial fetch + interval + focus-refresh.
  useEffect(() => {
    if (!isAuthed) return;
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [isAuthed, refresh]);

  return { queue, loading, error, refresh, ack };
}
