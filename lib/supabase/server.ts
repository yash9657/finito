import { auth } from "@clerk/nextjs/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * RLS-scoped Supabase client for Server Components and Route Handlers (per D5). It carries
 * the caller's Clerk session token, which Supabase accepts as a third-party auth token, so
 * reads are protected by RLS — the caller's session determines org scope. All privileged
 * writes / Storage access go through the admin client.
 */
export async function createClient() {
  const { getToken } = await auth();

  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { accessToken: async () => (await getToken()) ?? null },
  );
}
