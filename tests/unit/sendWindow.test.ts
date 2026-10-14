import { describe, expect, it } from "vitest";
import { effectiveWindow, isWithinWindow, nextWindowOpen } from "@/lib/compliance/sendWindow";
import { resolveTimezone } from "@/lib/compliance/geo";

const w = effectiveWindow({ orgSendSundays: true, orgSendHolidays: true });

describe("send window", () => {
  it("defaults to 09:00-20:00 local", () => {
    expect(w).toMatchObject({ start: "09:00", end: "20:00" });
    // 2026-10-14 is a Wednesday. 13:59Z = 08:59 CDT
    expect(isWithinWindow(new Date("2026-10-14T13:59:00Z"), ["America/Chicago"], w)).toBe(false);
    expect(isWithinWindow(new Date("2026-10-14T14:00:00Z"), ["America/Chicago"], w)).toBe(true);
    expect(isWithinWindow(new Date("2026-10-15T00:59:00Z"), ["America/Chicago"], w)).toBe(true); // 19:59
    expect(isWithinWindow(new Date("2026-10-15T01:00:00Z"), ["America/Chicago"], w)).toBe(false); // 20:00
  });

  it("clamps configured windows to 08:00-21:00", () => {
    const x = effectiveWindow({ playbookWindow: { start: "06:00", end: "23:30" }, orgSendSundays: true, orgSendHolidays: true });
    expect(x).toMatchObject({ start: "08:00", end: "21:00" });
  });

  it("uses the strictest of candidate zones", () => {
    // 09:30 Eastern = 08:30 Central -> not allowed when both are candidates
    const at = new Date("2026-10-14T13:30:00Z");
    expect(isWithinWindow(at, ["America/New_York"], w)).toBe(true);
    expect(isWithinWindow(at, ["America/New_York", "America/Chicago"], w)).toBe(false);
    expect(nextWindowOpen(at, ["America/New_York", "America/Chicago"], w)!.toISOString()).toBe("2026-10-14T14:00:00.000Z");
  });

  it("finds the next opening after the window closes", () => {
    const at = new Date("2026-10-15T02:00:00Z"); // 21:00 CDT Wed
    expect(nextWindowOpen(at, ["America/Chicago"], w)!.toISOString()).toBe("2026-10-15T14:00:00.000Z");
  });

  it("handles daylight saving transitions", () => {
    // DST ends 2026-11-01 in the US. Monday 2026-11-02 09:00 CST = 15:00Z
    const at = new Date("2026-11-02T03:00:00Z"); // Sun 21:00 CST
    expect(nextWindowOpen(at, ["America/Chicago"], w)!.toISOString()).toBe("2026-11-02T15:00:00.000Z");
    // DST starts 2027-03-14. Sunday 09:00 CDT = 14:00Z
    expect(nextWindowOpen(new Date("2027-03-14T06:00:00Z"), ["America/Chicago"], w)!.toISOString()).toBe("2027-03-14T14:00:00.000Z");
  });

  it("skips Sundays and holidays when turned off", () => {
    const noSun = effectiveWindow({ orgSendSundays: false, orgSendHolidays: true });
    const sat = new Date("2026-10-18T02:00:00Z"); // Sat 21:00 CDT
    expect(nextWindowOpen(sat, ["America/Chicago"], noSun)!.toISOString()).toBe("2026-10-19T14:00:00.000Z"); // Monday
    const noHol = effectiveWindow({ orgSendSundays: true, orgSendHolidays: false });
    // Thanksgiving 2026-11-26
    expect(isWithinWindow(new Date("2026-11-26T18:00:00Z"), ["America/Chicago"], noHol)).toBe(false);
    expect(isWithinWindow(new Date("2026-11-27T18:00:00Z"), ["America/Chicago"], noHol)).toBe(true);
  });

  it("playbook sundays:false turns off Sundays", () => {
    const x = effectiveWindow({ playbookWindow: { start: "09:00", end: "20:00", sundays: false }, orgSendSundays: true, orgSendHolidays: true });
    expect(x.sundays).toBe(false);
  });

  it("applies state overrides (stricter only)", () => {
    const fl = effectiveWindow({ playbookWindow: { start: "08:00", end: "21:00" }, orgSendSundays: true, orgSendHolidays: true, usState: "FL" });
    expect(fl).toMatchObject({ start: "08:00", end: "20:00" });
  });
});

describe("timezone resolution", () => {
  it("prefers ZIP", () => {
    expect(resolveTimezone({ zip: "60126", phone: "+12125550100", orgTimezone: "America/Chicago" })).toMatchObject({ timezone: "America/Chicago", candidates: ["America/Chicago"], usState: "IL", source: "zip" });
    expect(resolveTimezone({ zip: "32501", orgTimezone: "America/New_York" }).timezone).toBe("America/Chicago"); // Pensacola
    expect(resolveTimezone({ zip: "79901", orgTimezone: "America/Chicago" }).timezone).toBe("America/Denver"); // El Paso
  });
  it("returns all candidates for split states without a pin", () => {
    expect(resolveTimezone({ zip: "67202", orgTimezone: "America/Chicago" }).candidates).toEqual(["America/Chicago", "America/Denver"]);
  });
  it("falls back to area code, keeping the org zone as a candidate", () => {
    const g = resolveTimezone({ phone: "+13125550100", orgTimezone: "America/New_York" });
    expect(g).toMatchObject({ usState: "IL", source: "area_code", timezone: "America/Chicago" });
    expect(g.candidates).toEqual(["America/Chicago", "America/New_York"]);
  });
  it("falls back to the org zone", () => {
    expect(resolveTimezone({ orgTimezone: "America/Chicago" })).toMatchObject({ timezone: "America/Chicago", source: "org" });
  });
});
