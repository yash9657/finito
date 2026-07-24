import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Cookie-scoped Supabase client for Server Components, Route Handlers, and auth
 * checks (per D5). Reads are protected by RLS — the caller's session determines
 * org scope. All privileged writes / Storage access go through the admin client.
 *
 * `cookies()` is async in Next 15, so this factory is async.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // The `setAll` method was called from a Server Component. This can be
            // ignored if there is middleware refreshing user sessions.
          }
        },
      },
    },
  );
}
