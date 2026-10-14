// Opt-out detection. Carrier keywords are matched exactly; plain-language versions are caught by a
// deterministic phrase list first and then by the fast model classifier (lib/agent/classify.ts).
// Scope: "sms" stops automated texts; "all" stops every channel.

export type OptOutScope = "sms" | "all";
export interface OptOutResult {
  optOut: boolean;
  scope?: OptOutScope;
  reason?: "keyword" | "phrase" | "wrong_number" | "classifier";
  optIn?: boolean; // START / UNSTOP
}

// CTIA / carrier standard opt-out keywords (Twilio Advanced Opt-Out defaults plus common variants).
export const STOP_KEYWORDS = ["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT OUT", "REVOKE", "REMOVE"];
// Only these turn SMS back on. The app never re-enables SMS on its own.
export const START_KEYWORDS = ["START", "UNSTOP"];

const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[‘’]/g, "'")
    .toUpperCase()
    .replace(/[^A-Z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const ALL_CHANNEL_PHRASES = [
  /\bSTOP (CONTACTING|CALLING|EMAILING|MESSAGING|BOTHERING) ME\b/,
  /\bDO ?N'?T (CONTACT|CALL|EMAIL|MESSAGE|BOTHER) ME\b/,
  /\bDO NOT (CONTACT|CALL|EMAIL|MESSAGE) ME\b/,
  /\bLEAVE ME ALONE\b/,
  /\bREMOVE ME FROM (YOUR|THE|THIS) (LIST|LISTS|DATABASE|SYSTEM)\b/,
  /\bTAKE ME OFF (YOUR|THE|THIS) (LIST|LISTS)\b/,
  /\bNEVER (CONTACT|TEXT|CALL|EMAIL) ME\b/,
  /\bLOSE MY NUMBER\b/,
];
const SMS_PHRASES = [
  /\bSTOP (TEXTING|TXTING|SENDING)( ME)?\b/,
  /\bDO ?N'?T TE?XT ME\b/,
  /\bDO NOT TE?XT ME\b/,
  /\bNO MORE (TEXTS|TEXT MESSAGES|MESSAGES)\b/,
  /\bUNSUBSCRIBE\b/,
  /\bOPT ME OUT\b/,
];
const WRONG_NUMBER = [/\bWRONG (NUMBER|PERSON|#)\b/, /\bYOU HAVE THE WRONG\b/, /\bTHIS IS NOT \w+'?S? (NUMBER|PHONE)\b/, /\bI ?(DID NOT|DIDN'T|NEVER) (FILL|SIGN|SUBMIT|REQUEST)/];
// "Unsubscribe" in Spanish and a few common translations of stop.
const SPANISH = [/^(ALTO|PARAR|PARA|BASTA|CANCELAR|DETENER)$/, /\bNO ME (ESCRIBAS|ESCRIBAN|MANDES|MANDEN|CONTACTES|CONTACTEN|LLAMES)\b/];

export function detectOptOut(body: string): OptOutResult {
  const n = normalize(body);
  if (!n) return { optOut: false };
  if (START_KEYWORDS.includes(n)) return { optOut: false, optIn: true };
  if (ALL_CHANNEL_PHRASES.some((r) => r.test(n))) return { optOut: true, scope: "all", reason: "phrase" };
  // Keyword alone, or keyword followed by a short tail ("Stop please", "STOP!!!", "stop it").
  const words = n.split(" ");
  if (STOP_KEYWORDS.includes(n) || (words.length <= 3 && STOP_KEYWORDS.includes(words[0]) && !["END", "CANCEL", "REMOVE"].includes(words[0]) && words[1] !== "BY")) {
    return { optOut: true, scope: "sms", reason: "keyword" };
  }
  if (SMS_PHRASES.some((r) => r.test(n))) return { optOut: true, scope: "sms", reason: "phrase" };
  if (SPANISH.some((r) => r.test(n))) return { optOut: true, scope: "sms", reason: "phrase" };
  if (WRONG_NUMBER.some((r) => r.test(n))) return { optOut: true, scope: "sms", reason: "wrong_number" };
  return { optOut: false };
}

/** Cheap pre-filter: is this message worth sending to the model classifier? */
export function mightBeOptOut(body: string): boolean {
  const n = normalize(body);
  return /\b(STOP|TEXT|CONTACT|NUMBER|REMOVE|ALONE|UNSUB|LIST|SPAM|BOTHER|HARASS|REPORT|BLOCK|NO MORE|NOT INTERESTED)\b/.test(n);
}

export const OPT_OUT_CONFIRMATION_SMS = (businessName: string) =>
  `${businessName}: You're unsubscribed and won't receive more texts from us. Reply START to resubscribe.`;
