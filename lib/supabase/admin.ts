import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client (per D5). Bypasses RLS and has full read/write
 * access, including the private `workflow-files` Storage bucket.
 *
 * SECURITY: only import this from `app/api/**` and `lib/agents/**`, and only
 * after verifying the caller owns the workflow (org check). Never import it into
 * client components or Server Components rendered to the browser — the
 * SUPABASE_SERVICE_ROLE_KEY must never reach the client.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
