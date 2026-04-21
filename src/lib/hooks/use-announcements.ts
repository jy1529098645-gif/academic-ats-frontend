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
import { buildApiUrl, fetchWithApiFallback } from "@/lib/api";

export type Announcement = {
  id:           string;
  author_email: string;
  text:         string;
  created_at:   string;
};

const FEED_LIMIT = 50;

export function useAnnouncements() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [error, setError] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetchWithApiFallback("/api/announcements");
      if (!res.ok) throw new Error(`announcements: HTTP ${res.status}`);
      const data = (await res.json()) as Announcement[];
      setItems((data ?? []).slice(0, FEED_LIMIT));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
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
  }, []);

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
      const { fetchWithAuth } = await import("@/lib/api");
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
