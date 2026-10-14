// All business logic reads time through now(). Tests set a fixed time; in DRY_RUN the simulator's
// "advance 1 day" button moves a platform-wide offset (platform_state.clock_offset_ms).
import { env } from "./env";

let fixed: Date | null = null;
let offsetMs = 0;

export function now(): Date {
  if (fixed) return new Date(fixed.getTime());
  return new Date(Date.now() + offsetMs);
}

/** Tests only: freeze time. */
export function setNow(d: Date | string | null) {
  fixed = d === null ? null : new Date(d);
}

/** Tests only: move frozen time forward. */
export function advance(ms: number) {
  if (!fixed) throw new Error("advance() requires a frozen clock");
  fixed = new Date(fixed.getTime() + ms);
}

/** The simulator offset is honoured only in dry-run, so it can never shift production sends. */
export function setOffsetMs(ms: number) {
  offsetMs = env.dryRun ? ms : 0;
}

export function getOffsetMs() {
  return offsetMs;
}
