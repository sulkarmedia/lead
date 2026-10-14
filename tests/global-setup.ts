// Starts the local Postgres (if needed) and rebuilds the test database from migrations once per run.
import { execSync } from "node:child_process";
import pg from "pg";
import { migrate } from "../scripts/migrate";

export default async function setup() {
  const base = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";
  if (!process.env.TEST_DATABASE_ADMIN_URL) execSync("bash scripts/local-db.sh", { stdio: "ignore" });
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query("drop database if exists leadline_test with (force)");
  await admin.query("create database leadline_test");
  await admin.end();
  const url = base.replace(/\/[^/]+$/, "/leadline_test");
  await migrate(url, { shim: true });
  process.env.DATABASE_URL = url;
}
