import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Machine-to-machine auth for the /api/v1 surface.
 *
 * Everything else in this app authenticates a browser session. These routes are
 * called by another system (a publishing tool that creates a campaign for the
 * reel it just queued), so they get a static key instead — deliberately NOT
 * CRON_SECRET and never falling back to NEXTAUTH_SECRET, because this surface
 * writes campaign rows and has to be rotatable on its own.
 *
 * Compared over SHA-256 digests with timingSafeEqual: hashing first keeps the
 * comparison constant-length, so a wrong key never leaks the right key's length
 * through a thrown error.
 */
export type ApiKeyCheck =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

export function checkApiKey(request: Request): ApiKeyCheck {
  const expected = process.env.OPENREPLY_API_KEY;
  if (!expected) {
    // Self-hosted: saying the key is unset is diagnosis, not disclosure.
    return { ok: false, status: 503, error: "OPENREPLY_API_KEY is not set on this instance" };
  }

  const header = request.headers.get("authorization");
  const presented =
    (header && /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim()) ||
    request.headers.get("x-api-key")?.trim() ||
    "";
  if (!presented) return { ok: false, status: 401, error: "Missing API key" };

  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) return { ok: false, status: 401, error: "Invalid API key" };

  return { ok: true };
}
