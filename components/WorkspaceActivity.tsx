"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

type PendingView = { id: string; action: "page_view"; route: string };
const ROUTE =
  /^\/(?:dashboard|data|investigations(?:\/[0-9a-f-]{36})?|settings(?:\/(?:models|approvals|memory))?|workflows\/(?:new|[0-9a-f-]{36}(?:\/report)?))$/i;

/** Best-effort navigation history, separate from transactional business-event capture.
 * Only pathnames are retained. Query strings, typed values and DOM contents never enter this queue.
 */
export function WorkspaceActivity({ identity }: { identity: string }) {
  const pathname = usePathname();
  const last = useRef("");
  const flush = useRef<(() => void) | null>(null);
  const queue = useRef<PendingView[]>([]);
  const key = `finflow:views:${identity}`;

  useEffect(() => {
    let stopped = false;
    let working = false;
    const persist = () => {
      try {
        sessionStorage.setItem(key, JSON.stringify(queue.current));
      } catch {
        /* Private browsing can disable storage. */
      }
    };
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      if (Array.isArray(saved))
        queue.current = saved
          .filter(
            (event): event is PendingView =>
              typeof event?.id === "string" &&
              /^[0-9a-f-]{36}$/i.test(event.id) &&
              event.action === "page_view" &&
              typeof event.route === "string" &&
              ROUTE.test(event.route),
          )
          .slice(-100);
    } catch {
      queue.current = [];
    }
    const send = async () => {
      if (working || stopped || !navigator.onLine) return;
      working = true;
      try {
        for (let n = 0; queue.current.length && n < 10 && !stopped; n++) {
          const current = queue.current[0];
          const response = await fetch("/api/memory/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(current),
            signal: AbortSignal.timeout(10_000),
            keepalive: true,
          });
          if (stopped) break;
          if (response.ok || [400, 403, 404].includes(response.status)) {
            queue.current = queue.current.filter(
              (event) => event.id !== current.id,
            );
            persist();
          } else break;
        }
      } catch {
        /* Retry the same event UUID on reconnect; do not interrupt finance work. */
      } finally {
        working = false;
      }
    };
    flush.current = () => {
      persist();
      void send();
    };
    const retry = () => {
      void send();
    };
    const interval = setInterval(retry, 30_000);
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    void send();
    return () => {
      stopped = true;
      flush.current = null;
      persist();
      clearInterval(interval);
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
    };
  }, [key]);

  useEffect(() => {
    if (!ROUTE.test(pathname) || last.current === `${identity}:${pathname}`)
      return;
    last.current = `${identity}:${pathname}`;
    queue.current.push({
      id: crypto.randomUUID(),
      action: "page_view",
      route: pathname,
    });
    queue.current = queue.current.slice(-100);
    flush.current?.();
  }, [pathname, identity]);

  return null;
}
