import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { twilioSignature, verifyTwilioSignature } from "@/lib/integrations/twilio";
import { verifyMetaSignature } from "@/lib/integrations/meta";
import { verifyPostmarkInbound, replyTokenFrom, PostmarkInbound } from "@/lib/integrations/postmark";
import { signWebhook } from "@/lib/integrations/webhooks";
import { decrypt, encrypt } from "@/lib/crypto";

describe("Twilio X-Twilio-Signature", () => {
  // Example from Twilio's webhook security docs.
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  it("matches Twilio's documented example", () => {
    expect(twilioSignature(token, url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });
  it("verifies and rejects", () => {
    expect(verifyTwilioSignature(token, url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(true);
    expect(verifyTwilioSignature(token, url, { ...params, Digits: "9" }, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(false);
    expect(verifyTwilioSignature(token, url, params, null)).toBe(false);
  });
});

describe("Meta X-Hub-Signature-256", () => {
  it("verifies the raw body HMAC", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifyMetaSignature(body, sig, "s3cret")).toBe(true);
    expect(verifyMetaSignature(body + " ", sig, "s3cret")).toBe(false);
    expect(verifyMetaSignature(body, sig, "other")).toBe(false);
  });
});

describe("Postmark inbound", () => {
  it("requires the shared secret", () => {
    process.env.POSTMARK_INBOUND_WEBHOOK_SECRET = "pm-secret";
    expect(verifyPostmarkInbound({ url: "https://app/x?token=pm-secret", authorization: null })).toBe(true);
    expect(verifyPostmarkInbound({ url: "https://app/x", authorization: "Basic " + Buffer.from("postmark:pm-secret").toString("base64") })).toBe(true);
    expect(verifyPostmarkInbound({ url: "https://app/x?token=nope", authorization: null })).toBe(false);
  });
  it("extracts the per-lead reply token", () => {
    const p = PostmarkInbound.parse({ From: "a@b.com", To: "lead-0123456789abcdef01234567@inbound.example.com", MessageID: "m1" });
    expect(replyTokenFrom(p)).toBe("0123456789abcdef01234567");
  });
});

describe("outbound webhooks and secrets", () => {
  it("signs with timestamp", () => {
    expect(signWebhook("k", "{}", 1700000000)).toBe(`t=1700000000,sha256=${createHmac("sha256", "k").update("1700000000.{}").digest("hex")}`);
  });
  it("AES-GCM round trip and tamper detection", () => {
    const c = encrypt("token-123");
    expect(decrypt(c)).toBe("token-123");
    const parts = c.split(".");
    parts[3] = Buffer.from("zzz").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
});
