// Per-state overrides for send windows and frequency caps, applied by the lead's state (from ZIP or
// area code). Ships with the platform defaults; the TCPA attorney fills in the overrides.
// Entries can only make rules stricter: windows are intersected and caps take the minimum.
export interface StateRule {
  window?: { start: string; end: string };   // lead-local HH:MM
  maxAutomatedPer24h?: number;
  sundays?: boolean;                           // false = no automated texts on Sundays
  holidays?: boolean;                          // false = no automated texts on state/federal holidays
  note?: string;
}

export const STATE_RULES: Record<string, StateRule> = {
  // ATTORNEY TO CONFIRM. Placeholders reflect commonly cited state "mini-TCPA" limits so the
  // mechanism is exercised; they are engineering defaults, not legal advice.
  FL: { window: { start: "08:00", end: "20:00" }, maxAutomatedPer24h: 3, note: "FTSA: 8am-8pm, 3 per 24h (confirm)" },
  OK: { window: { start: "08:00", end: "20:00" }, maxAutomatedPer24h: 3, note: "OK Telephone Solicitation Act (confirm)" },
  MD: { window: { start: "08:00", end: "20:00" }, maxAutomatedPer24h: 3, note: "Stop the Spam Calls Act (confirm)" },
};

export const PLATFORM_DEFAULTS = {
  window: { start: "09:00", end: "20:00" },
  clamp: { start: "08:00", end: "21:00" },
  maxAutomatedPer24h: 3,
};
