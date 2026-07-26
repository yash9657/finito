/**
 * The browser Supabase client (Plan 5 §9).
 *
 * Exists for ONE reason: Realtime. Every other client-side read in FinFlow goes through an API
 * route with the service-role client behind it (D5), and that stays true — this client is used
 * only to subscribe to `harness_events`, under the org-scoped SELECT policy 004 created for
 * exactly this purpose (D-H5).
 *
 * It therefore carries the ANON key, never the service-role one. The anon key is public by
 * design — it is already in the page bundle for auth — and RLS is what scopes what it can see.
 * A service-role key here would hand every browser a bypass of every policy in the schema.
 *
 * Memoized because `createBrowserClient` opens a websocket: a new client per render would leak
 * one per keystroke.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (client) return client;
  client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return client;
}
