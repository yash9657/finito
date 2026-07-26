"use client";

/**
 * useInvestigation — the transcript's data driver (Plan 5 §9, D-H5).
 *
 * Realtime replaces the 2s poll `useWorkflowStatus` uses, because an investigation emits events
 * in bursts — a turn can produce six in under a second and then nothing for twenty — and a fixed
 * poll either misses the burst's shape or wastes requests during the pause.
 *
 * ## Why there is still a poll
 *
 * Realtime is a websocket to a service that can be down, blocked by a corporate proxy, or simply
 * not enabled on a self-hosted Postgres. A transcript that silently stops updating is worse than
 * one that updates slowly, so:
 *
 *   - a full fetch on mount seeds the state and gives the events their authoritative order;
 *   - Realtime appends inserts as they arrive;
 *   - a SLOW poll (10s) runs only while the run is live, as a safety net.
 *
 * The poll is not redundant with Realtime — it is what makes the absence of Realtime survivable.
 * `subscribed` is surfaced so the UI can say which mode it is in rather than leaving the user to
 * guess why nothing is moving.
 *
 * Events are keyed by `sequence_number`, which the database allocates gaplessly per workflow
 * (D-H3). That makes deduplication exact: a websocket delivery and a poll can both bring the same
 * event and only one survives, with no timestamp heuristics.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import type { ActionRequest, HarnessEvent, Investigation } from "@/lib/types";

/** Only while the run is live, and deliberately slow — Realtime is the primary path. */
const FALLBACK_POLL_MS = 10_000;

export interface InvestigationView {
  investigation: Investigation;
  workflow: {
    id: string;
    name: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  };
  events: HarnessEvent[];
  actions: ActionRequest[];
}

export interface UseInvestigation {
  data: InvestigationView | null;
  error: Error | null;
  isLoading: boolean;
  /** True when the websocket is connected — shown in the UI, not just logged. */
  subscribed: boolean;
  refetch: () => void;
}

export function useInvestigation(id: string): UseInvestigation {
  const [data, setData] = useState<InvestigationView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(false);

  const mountedRef = useRef(true);
  const fetchTokenRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    try {
      const res = await fetch(`/api/investigations/${id}`, { cache: "no-store" });
      if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // non-JSON error body — keep the generic message
        }
        throw new Error(message);
      }
      const body = (await res.json()) as InvestigationView;
      // A stale in-flight fetch must not overwrite a newer one.
      if (!mountedRef.current || token !== fetchTokenRef.current) return;
      setData(body);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== fetchTokenRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (mountedRef.current && token === fetchTokenRef.current) setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchAll();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchAll]);

  /* ---- Realtime ---------------------------------------------------------- */
  useEffect(() => {
    const supabase = getBrowserClient();
    const channel = supabase
      .channel(`investigation:${id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "harness_events",
          filter: `workflow_id=eq.${id}`,
        },
        (payload) => {
          const event = payload.new as HarnessEvent;
          setData((current) => {
            if (!current) return current;
            // Gapless per-workflow sequence numbers make dedup exact (D-H3) — no timestamps,
            // no heuristics, and a poll and a socket delivery of the same row collapse cleanly.
            if (current.events.some((e) => e.sequence_number === event.sequence_number)) {
              return current;
            }
            return {
              ...current,
              events: [...current.events, event].sort(
                (a, b) => a.sequence_number - b.sequence_number,
              ),
            };
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "investigations",
          filter: `workflow_id=eq.${id}`,
        },
        // The projection row changes once, at the end. Refetch rather than merge: it arrives
        // with the answer, and the actions list changes at the same moment.
        () => void fetchAll(),
      )
      .subscribe((status) => {
        if (!mountedRef.current) return;
        setSubscribed(status === "SUBSCRIBED");
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [id, fetchAll]);

  /* ---- The safety net ---------------------------------------------------- */
  useEffect(() => {
    const running = data?.investigation.status === "running";
    if (!running) return;
    const timer = setInterval(() => void fetchAll(), FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [data?.investigation.status, fetchAll]);

  return { data, error, isLoading, subscribed, refetch: fetchAll };
}
