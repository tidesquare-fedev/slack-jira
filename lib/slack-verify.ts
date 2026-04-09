import { createHmac, timingSafeEqual } from "crypto";

const SKEW_SEC = 60 * 5;

export function verifySlackRequest(
  signingSecret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > SKEW_SEC) {
    return false;
  }
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${hmac}`;
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
