// ─────────────────────────────────────────────────────────────────────────────
// useAnnouncements — live feed of the shared public ticker.
//
// Three channels feed this state:
//   1. GET /api/announcements — one-shot REST fetch on mount to seed the
//      latest 50 messages so a brand-new tab isn't empty while Realtime is
//      still warming up.
//   2. Supabase Realtime INSERT — pushes new rows to every connected
//      session in near-real-time.
//   3. Supabase Realtime DELETE — drops removed rows from every session's
//      state so dev-tier "Clear user-posted" / "Clear all" operations
//      propagate without requiring a page reload. The DELETE payload
//      carries only the primary key by default (REPLICA IDENTITY DEFAULT),
//      which is enough because we filter local state by id.
//
// Auth isn't required to read the feed (endpoint is public); posting and
// deletion go through backend-auth'd endpoints elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { buildApiUrl, fetchWithApiFallback, fetchWithAuth } from "@/lib/api";

export type Announcement = {
  id:             string;
  author_email:   string;
  text:           string;
  created_at:     string;
};

const FEED_LIMIT = 50;

/**
 * `enabled` defaults to true for backwards compat, but the main app
 * passes `!!authUser` so the REST fetch + Realtime subscription don't
 * fire while the user is sitting on the login overlay. Without this
 * gate we were opening a Supabase realtime channel + hitting
 * /api/announcements on every cold visit, including bots / scrapers
 * that never sign in — pure waste on the WebSocket connection pool
 * and on the dyno's CPU. The channel cleans up if `enabled` flips
 * back to false (e.g. on sign-out).
 */
export function useAnnouncements(enabled: boolean = true) {
  const [items, setItems] = useState<Announcement[]>([]);
  const [error, setError] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetchWithAuth(buildApiUrl("/api/announcements"));
      if (!res.ok) throw new Error(`announcements: HTTP ${res.status}`);
      const data = (await res.json()) as Announcement[];
      setItems((data ?? []).slice(0, FEED_LIMIT));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [refresh, enabled]);

  useEffect(() => {
    if (!enabled) return;
    // Live subscription — INSERT prepends, DELETE drops. Dedup on id in
    // both directions so REST refresh + Realtime echo of the same row
    // stay consistent.
    const channel = supabase
      .channel("announcements-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "announcements" },
        (payload: { new: Announcement }) => {
          const row = payload.new;
          if (!row || !row.id) return;
          setItems(prev => {
            if (prev.some(p => p.id === row.id)) return prev;
            return [row, ...prev].slice(0, FEED_LIMIT);
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "announcements" },
        (payload: { old: { id?: string } }) => {
          const oldId = payload.old?.id;
          if (!oldId) return;
          setItems(prev => prev.filter(p => p.id !== oldId));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled]);

  /** Fire-and-forget post; relies on Realtime to echo the new row back.
   *  `anonymous: true` asks the server to record the row with an empty
   *  author_email so the ticker renders it as "Anonymous User". */
  const post = useCallback(async (
    text: string,
    opts?: { anonymous?: boolean },
  ): Promise<{ ok: boolean; error?: string }> => {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return { ok: false, error: "text is empty" };
    try {
      const res = await fetchWithAuth(buildApiUrl("/api/announcements"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, anonymous: !!opts?.anonymous }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      // Optimistic append — Realtime will dedup on id.
      try {
        const row = (await res.json()) as Announcement;
        if (row?.id) {
          setItems(prev => prev.some(p => p.id === row.id) ? prev : [row, ...prev].slice(0, FEED_LIMIT));
        }
      } catch { /* response body not JSON — ignore */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, []);

  return { items, error, refresh, post };
}
