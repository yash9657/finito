"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "@/lib/types";

const POLL_MS = 2000;
export interface UseWorkflowStatus {
  data: StatusResponse | null;
  error: Error | null;
  isLoading: boolean;
  refetch: () => void;
}

/** Serial polling with cancellation, bounded retries and no stale status closure. */
export function useWorkflowStatus(id: string): UseWorkflowStatus {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const previousId = useRef(id);
  const refetch = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    let failures = 0;
    if (previousId.current !== id) {
      setData(null);
      previousId.current = id;
    }
    setIsLoading(true);
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      let shouldPoll = false;
      try {
        const res = await fetch(`/api/workflows/${id}/status`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await res.json();
        if (!res.ok)
          throw new Error(body.error ?? `Status unavailable (${res.status})`);
        if (!active) return;
        setData(body as StatusResponse);
        setError(null);
        failures = 0;
        shouldPoll = ["running", "awaiting_approval"].includes(
          body.workflow.status,
        );
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err : new Error("Status unavailable"));
        failures += 1;
        shouldPoll = failures <= 4;
      } finally {
        clearTimeout(timeout);
        if (active) {
          setIsLoading(false);
          if (shouldPoll)
            timer = setTimeout(poll, Math.min(30_000, POLL_MS * 2 ** failures));
        }
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [id, refresh]);

  return { data, error, isLoading, refetch };
}
export default useWorkflowStatus;
