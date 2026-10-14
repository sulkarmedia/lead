import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg"],
  typedRoutes: false,
  // Lets e2e run its own dev server next to a regular one without sharing build output.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};
export default config;
