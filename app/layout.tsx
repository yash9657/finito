import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import DemoMount from "@/demo/engine/DemoMount";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "FinFlow — Source to sign-off", template: "%s · FinFlow" },
  description:
    "Reconcile accounts, review invoices, and explain variances with a clear record of sources, calculations, and approvals.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        {/* The guided demo overlay. Off unless NEXT_PUBLIC_DEMO=1; see demo/README.md. */}
        {process.env.NEXT_PUBLIC_DEMO === "1" && <DemoMount />}
      </body>
    </html>
  );
}
