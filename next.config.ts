import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg"],
  typedRoutes: false,
};
export default config;
