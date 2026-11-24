import type { NextConfig } from "next";

/** Backend origin. The browser never talks to it directly: /api, /media and /oauth are proxied so cookies + SSE stay same-origin. */
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://localhost:4000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/media/:path*", destination: `${BACKEND_URL}/api/media/:path*` },
      { source: "/oauth/:path*", destination: `${BACKEND_URL}/oauth/:path*` },
    ];
  },
};

export default nextConfig;
