// Web processes pick up the simulator's clock offset (dry-run only) on each request.
import { maybeOne, service } from "./db";
import { env } from "./env";
import { setOffsetMs } from "./clock";

export async function syncClock() {
  if (!env.dryRun) return setOffsetMs(0);
  const row = await maybeOne<{ value: { ms: number } }>(service(), "select value from platform_state where key = 'clock_offset_ms'").catch(() => null);
  setOffsetMs(row?.value.ms ?? 0);
}
