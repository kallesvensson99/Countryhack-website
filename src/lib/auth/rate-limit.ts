import { db } from "../db";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter in Postgres. The upsert is atomic, so concurrent
 * requests can't undercount.
 */
export async function rateLimit(
  key: string,
  opts: { limit: number; windowSeconds: number },
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowMs = opts.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("id", "key", "windowStart", "count", "updatedAt")
    VALUES (gen_random_uuid()::text, ${key}, ${windowStart}, 1, NOW())
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimit"."count" + 1, "updatedAt" = NOW()
    RETURNING "count"`;
  const count = rows[0]?.count ?? 1;
  return {
    ok: count <= opts.limit,
    remaining: Math.max(0, opts.limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000)),
  };
}

export async function deleteOldRateLimits(olderThanHours = 24): Promise<number> {
  const r = await db.rateLimit.deleteMany({ where: { windowStart: { lt: new Date(Date.now() - olderThanHours * 3600_000) } } });
  return r.count;
}

/** Named policies so limits live in one place. */
export const LIMITS = {
  loginIp: { limit: 30, windowSeconds: 900 },
  loginEmail: { limit: 10, windowSeconds: 900 },
  registerIp: { limit: 10, windowSeconds: 3600 },
  resetIp: { limit: 10, windowSeconds: 3600 },
  resetEmail: { limit: 3, windowSeconds: 3600 },
  verifyResendUser: { limit: 3, windowSeconds: 3600 },
  verifyResendIp: { limit: 10, windowSeconds: 3600 },
} as const;
