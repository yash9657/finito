import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["quickjs-emscripten", "unpdf"],
  outputFileTracingIncludes: {
    "/api/investigations": [
      "./lib/harness/agent/sandbox/worker.cjs",
      "./node_modules/@jitl/quickjs-*/**/*",
      "./node_modules/quickjs-emscripten*/**/*",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
