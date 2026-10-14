import { describe, expect, it } from "vitest";
import { computeSlots, pickSpread } from "@/lib/booking/slots";
import { addBusinessMinutes } from "@/lib/booking/hours";
import { DEFAULT_NO_REPLY, parseOffset, stepRunAt, stepsFor } from "@/lib/cadence";

const availability = { weekly_hours: { mon: [["09:00", "12:00"]], tue: [["09:00", "12:00"]], wed: [["09:00", "12:00"]], thu: [["09:00", "12:00"]], fri: [["09:00", "12:00"]], sat: [], sun: [] } as any, slot_minutes: 45, buffer_minutes: 15, min_notice_minutes: 120, max_days_ahead: 7, blackout_dates: ["2026-10-16"] };

describe("slot calculation", () => {
  const now = new Date("2026-10-14T13:30:00Z"); // Wed 08:30 CDT
  it("respects hours, slot length, buffer and minimum notice", () => {
    const s = computeSlots({ availability, businessTz: "America/Chicago", userId: null, booked: [], busy: [], now });
    const wed = s.filter((x) => x.start.toISOString().startsWith("2026-10-14"));
    // 09:00,10:00,11:00 local; notice of 2h from 08:30 removes 09:00 and 10:00 (10:00 < 10:30)
    expect(wed.map((x) => x.start.toISOString())).toEqual(["2026-10-14T16:00:00.000Z"]);
  });
  it("subtracts appointments and calendar busy time (with buffer) and blackout dates", () => {
    const s = computeSlots({
      availability, businessTz: "America/Chicago", userId: "u1", now,
      booked: [{ start: new Date("2026-10-15T14:00:00Z"), end: new Date("2026-10-15T14:45:00Z") }],
      busy: [{ start: new Date("2026-10-15T16:10:00Z"), end: new Date("2026-10-15T16:20:00Z") }],
    });
    const thu = s.filter((x) => x.start.toISOString().startsWith("2026-10-15")).map((x) => x.start.toISOString());
    expect(thu).toEqual(["2026-10-15T15:00:00.000Z"]);
    expect(s.some((x) => x.start.toISOString().startsWith("2026-10-16"))).toBe(false);
  });
  it("spreads up to 6 across days", () => {
    const s = computeSlots({ availability, businessTz: "America/Chicago", userId: null, booked: [], busy: [], now });
    expect(pickSpread(s, "America/Chicago").length).toBeLessThanOrEqual(6);
  });
});

describe("business-hour SLA math", () => {
  const weekly = { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]], thu: [["09:00", "18:00"]], fri: [["09:00", "18:00"]], sat: [], sun: [] } as any;
  it("counts only open minutes", () => {
    expect(addBusinessMinutes(new Date("2026-10-14T17:00:00Z"), 10, weekly, "America/Chicago").toISOString()).toBe("2026-10-14T17:10:00.000Z");
    // Wed 17:55 CDT + 10 → Thu 09:05
    expect(addBusinessMinutes(new Date("2026-10-14T22:55:00Z"), 10, weekly, "America/Chicago").toISOString()).toBe("2026-10-15T14:05:00.000Z");
  });
});

describe("cadence offsets", () => {
  it("default no-reply cadence then 6 monthly nurture touches", () => {
    const steps = stepsFor(null, "no_reply");
    expect(steps).toHaveLength(DEFAULT_NO_REPLY.length + 6);
    const anchor = new Date("2026-10-14T17:00:00Z");
    expect(stepRunAt(steps, 0, anchor, 6).getTime() - anchor.getTime()).toBe(parseOffset("2h"));
    expect(stepRunAt(steps, 5, anchor, 6).getTime() - anchor.getTime()).toBe(parseOffset("30d"));
    expect(stepRunAt(steps, 6, anchor, 6).getTime() - anchor.getTime()).toBe(parseOffset("60d"));
  });
});
