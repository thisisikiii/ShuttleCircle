import type { NextConfig } from "next";

const apiOrigin = process.env.API_ORIGIN;

const config: NextConfig = {
  output: "standalone",
  // local dev only: in production Caddy routes /api/* to the backend
  rewrites: async () =>
    apiOrigin ? [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }] : [],
};

export default config;
