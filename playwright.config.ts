import { defineConfig, devices } from "@playwright/test";

const DB = "postgres://postgres@127.0.0.1:54329/leadline_e2e";
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://localhost:3201", trace: "retain-on-failure" },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npx next dev -p 3201",
    url: "http://localhost:3201/login",
    reuseExistingServer: false,
    timeout: 180_000,
    env: { DATABASE_URL: DB, DEV_LOGIN: "true", DRY_RUN: "true", APP_URL: "http://localhost:3201", ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", NEXT_DIST_DIR: ".next-e2e" },
  },
});
