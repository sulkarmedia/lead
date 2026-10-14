import { describe, expect, it } from "vitest";
import { detectOptOut } from "@/lib/compliance/optOut";

describe("opt-out detection", () => {
  it.each(["STOP", "stop", "Stop.", " STOP!!! ", "STOPALL", "Unsubscribe", "cancel", "END", "QUIT", "opt out", "Stop please", "stop it"])(
    "carrier keyword %s -> sms opt-out",
    (m) => expect(detectOptOut(m)).toMatchObject({ optOut: true, scope: "sms" }),
  );
  it.each(["don't text me", "Dont text me anymore", "please stop texting me", "no more texts", "Do not text me"])(
    "plain language %s -> sms opt-out",
    (m) => expect(detectOptOut(m)).toMatchObject({ optOut: true, scope: "sms" }),
  );
  it.each(["stop contacting me", "Leave me alone", "remove me from your list", "Don't contact me again", "do not call me"])(
    "%s -> all channels",
    (m) => expect(detectOptOut(m)).toMatchObject({ optOut: true, scope: "all" }),
  );
  it("wrong number stops SMS", () => {
    expect(detectOptOut("wrong number")).toMatchObject({ optOut: true, reason: "wrong_number" });
    expect(detectOptOut("You have the wrong person")).toMatchObject({ optOut: true });
  });
  it.each(["START", "unstop"])("%s re-enables", (m) => expect(detectOptOut(m)).toMatchObject({ optOut: false, optIn: true }));
  it.each([
    "Can I stop by tomorrow at 3?",
    "I want to cancel my appointment",
    "What's the end of month deal?",
    "Yes I'm interested in the X5",
    "I need to stop at the bank first, then can come in",
    "remove the tint package please",
  ])("does not opt out on %s", (m) => expect(detectOptOut(m).optOut).toBe(false));
  it("spanish", () => expect(detectOptOut("No me escribas más")).toMatchObject({ optOut: true }));
});
