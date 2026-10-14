import { execSync } from "node:child_process";
import pg from "pg";

export default async function setup() {
  execSync("bash scripts/local-db.sh", { stdio: "ignore" });
  const admin = new pg.Client({ connectionString: "postgres://postgres@127.0.0.1:54329/postgres" });
  await admin.connect();
  await admin.query("drop database if exists leadline_e2e with (force)");
  await admin.query("create database leadline_e2e");
  await admin.end();
  const env = { ...process.env, DATABASE_URL: "postgres://postgres@127.0.0.1:54329/leadline_e2e", ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" };
  execSync("npx tsx scripts/migrate.ts --shim", { env, stdio: "inherit" });
  execSync("npx tsx scripts/seed.ts", { env, stdio: "inherit" });
}
