"use client";

/**
 * useWorkflowStatus — the client-side driver for the live workflow view (D1).
 *
 * Fetches GET /api/workflows/[id]/status immediately, then polls every 2000ms
 * WHILE the workflow is `running`. Polling stops on every terminal/awaiting
 * state (awaiting_review / approved / rejected / error / idle). `refetch()`
 * forces an out-of-band reload (used after a review decision is posted).
 *
 * Plain hook: useState/useEffect/useRef timer — no react-query.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/lib/types";

const POLL_MS = 2000;

export interface UseWorkflowStatus {
  data: StatusResponse | null;
  error: Error | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useWorkflowStatus(id: string): UseWorkflowStatus {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Timer handle + a mounted guard so late fetches can't set state after unmount.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef<boolean>(true);
  // A monotonically increasing token so a stale in-flight fetch can't overwrite
  // a newer one (e.g. an explicit refetch racing the polling fetch).
  const fetchTokenRef = useRef<number>(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    try {
      const res = await fetch(`/api/workflows/${id}/status`, {
        cache: "no-store",
      });
      if (!res.ok) {
        let message = `Status request failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // non-JSON error body — keep the generic message
        }
        throw new Error(message);
      }
      const body = (await res.json()) as StatusResponse;
      if (!mountedRef.current || token !== fetchTokenRef.current) return;
      setData(body);
      setError(null);

      // Reschedule only while running; otherwise polling halts here.
      clearTimer();
      if (body.workflow.status === "running") {
        timerRef.current = setTimeout(fetchStatus, POLL_MS);
      }
    } catch (err) {
      if (!mountedRef.current || token !== fetchTokenRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      // On error, keep polling if we already know the workflow was running, so
      // a transient network blip self-heals; otherwise stop and surface it.
      clearTimer();
      if (data?.workflow.status === "running") {
        timerRef.current = setTimeout(fetchStatus, POLL_MS);
      }
    } finally {
      if (mountedRef.current && token === fetchTokenRef.current) {
        setIsLoading(false);
      }
    }
  }, [id, clearTimer, data?.workflow.status]);

  const refetch = useCallback(() => {
    clearTimer();
    void fetchStatus();
  }, [clearTimer, fetchStatus]);

  useEffect(() => {
    mountedRef.current = true;
    setIsLoading(true);
    void fetchStatus();
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
    // Re-run only when the workflow id changes; fetchStatus is stable per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return { data, error, isLoading, refetch };
}

export default useWorkflowStatus;
