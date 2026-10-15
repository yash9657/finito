import { ClerkProvider } from "@clerk/nextjs";

/**
 * Clerk for the signed-in app and the sign-in/sign-up pages. Kept off the root layout so the
 * marketing page stays static and the build needs no Clerk keys.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      signInUrl="/login"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      appearance={{
        variables: {
          colorPrimary: "#d3e6bd",
          colorBackground: "#181d20",
          colorText: "#eef2f4",
          colorTextSecondary: "#a4afb7",
          colorInputBackground: "#101416",
          colorInputText: "#eef2f4",
          colorDanger: "#ff9e9e",
          colorTextOnPrimaryBackground: "#101416",
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
