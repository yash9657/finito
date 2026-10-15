import { cache } from "react";
import { auth, currentUser } from "@clerk/nextjs/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile } from "@/lib/types";

/**
 * The signed-in Clerk user's FinFlow profile, or null when signed out.
 *
 * Clerk owns identity; `profiles` owns org and role. The first request of a new Clerk user
 * provisions their profile (migration 019): an existing pre-Clerk profile with the same email
 * is claimed, otherwise a private workspace is created. Cached per request, so a layout and its
 * page share one lookup.
 */
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const { userId } = await auth();
  if (!userId) return null;

  const admin = createAdminClient();
  const { data: profile, error } = await admin
    .from("profiles")
    .select("*")
    .eq("clerk_user_id", userId)
    .maybeSingle<Profile>();
  if (error) {
    console.error("profile lookup failed", error);
    return null;
  }
  if (profile) return profile;

  // Claiming a pre-Clerk profile by email is only safe for an address Clerk has verified.
  const email = (await currentUser())?.primaryEmailAddress;
  if (!email || email.verification?.status !== "verified") return null;

  const { data: provisioned, error: provisionError } = await admin
    .rpc("provision_clerk_profile", {
      p_clerk_user_id: userId,
      p_email: email.emailAddress,
    })
    .single<Profile>();
  if (provisionError) {
    console.error("profile provisioning failed", provisionError);
    return null;
  }
  return provisioned;
});
