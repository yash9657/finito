/**
 * The browser Supabase client (Plan 5 §9).
 *
 * Exists for ONE reason: Realtime. Every other client-side read in FinFlow goes through an API
 * route with the service-role client behind it (D5), and that stays true — this client is used
 * only to subscribe to `harness_events`, under the org-scoped SELECT policy 004 created for
 * exactly this purpose (D-H5).
 *
 * It therefore carries the ANON key, never the service-role one, plus the caller's Clerk session
 * token, which Supabase accepts as a third-party auth token. RLS is what scopes what it can see.
 * A service-role key here would hand every browser a bypass of every policy in the schema.
 *
 * Memoized because the client opens a websocket: a new client per render would leak
 * one per keystroke.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type ClerkWindow = { Clerk?: { session?: { getToken(): Promise<string | null> } | null } };

let client: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (client) return client;
  client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      accessToken: async () =>
        (await (window as ClerkWindow).Clerk?.session?.getToken()) ?? null,
    },
  );
  return client;
}
