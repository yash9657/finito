import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Session-refresh helper for Next middleware (per @supabase/ssr SSR docs).
 * Refreshes the auth token, syncs cookies onto the response, and redirects
 * unauthenticated requests to `/login`. Public routes (`/login`, `/`, auth
 * callbacks) are allowed through without a session.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  // Marketing does not depend on database availability. API routes have JSON auth guards.
  if (request.nextUrl.pathname === "/") return supabaseResponse;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    if (request.nextUrl.pathname === "/login") return supabaseResponse;
    if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Service is not configured" }, { status: 503 });
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: Do not run code between createServerClient and getUser().
  // A simple mistake could make it very hard to debug issues with users being
  // randomly logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublicRoute =
    pathname === "/" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth");

  if (!user && !isPublicRoute) {
    if (pathname.startsWith("/api/")) {
      const response = NextResponse.json({ error: "Session expired. Sign in again." }, { status: 401 });
      for (const cookie of supabaseResponse.cookies.getAll()) response.cookies.set(cookie);
      return response;
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const response = NextResponse.redirect(url);
    for (const cookie of supabaseResponse.cookies.getAll()) response.cookies.set(cookie);
    return response;
  }

  // IMPORTANT: Return supabaseResponse as-is so refreshed auth cookies survive.
  return supabaseResponse;
}
