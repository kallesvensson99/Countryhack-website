import "dotenv/config";
import { deleteOldRateLimits } from "@/lib/auth/rate-limit";
import { deleteExpiredSessions } from "@/lib/auth/sessions";
import { processOutbox } from "@/lib/email/outbox";
import { releaseExpiredClaims } from "@/lib/seating/claims";
import { db } from "@/lib/db";

/**
 * Runs every minute (same image as the app, different command: `npm run worker`).
 * Stage (a): send queued emails, purge expired sessions / old rate-limit rows.
 * Stage (d) adds: expire unpaid orders, release seat holds, close Stripe sessions.
 */
export async function tick(): Promise<void> {
  const mail = await processOutbox();
  const sessions = await deleteExpiredSessions();
  const limits = await deleteOldRateLimits();
  const holds = await releaseExpiredClaims();
  if (mail.sent || mail.failed || sessions || limits || holds) {
    console.log(`[worker] emails sent=${mail.sent} failed=${mail.failed} sessionsPurged=${sessions} rateLimitRowsPurged=${limits} holdsReleased=${holds}`);
  }
}

async function main() {
  console.log("[worker] started");
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error("[worker] tick failed", err);
    }
    for (let i = 0; i < 60 && !stopping; i++) await new Promise((r) => setTimeout(r, 1000));
  }
  await db.$disconnect();
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && /worker[\\/]index\.[jt]s$/.test(process.argv[1])) void main();
