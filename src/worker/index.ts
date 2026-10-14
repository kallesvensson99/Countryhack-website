import "dotenv/config";
import { deleteOldRateLimits } from "@/lib/auth/rate-limit";
import { deleteExpiredSessions } from "@/lib/auth/sessions";
import { processOutbox } from "@/lib/email/outbox";
import { releaseExpiredClaims } from "@/lib/seating/claims";
import { expireDueOrders } from "@/lib/orders/expire";
import { db } from "@/lib/db";

/**
 * Runs every minute (same image as the app, different command: `npm run worker`).
 * Stage (a): send queued emails, purge expired sessions / old rate-limit rows.
 * Also expires unpaid orders (releasing ticket, food and seat hold) and closes their payment-provider sessions.
 */
export async function tick(): Promise<void> {
  const mail = await processOutbox();
  const sessions = await deleteExpiredSessions();
  const limits = await deleteOldRateLimits();
  const orders = await expireDueOrders(); // also releases the seat holds and closes provider sessions of expired orders
  const holds = await releaseExpiredClaims(); // safety net for stray expired holds
  if (mail.sent || mail.failed || sessions || limits || holds || orders.expired || orders.sessionsClosed) {
    console.log(`[worker] emails sent=${mail.sent} failed=${mail.failed} sessionsPurged=${sessions} rateLimitRowsPurged=${limits} holdsReleased=${holds} ordersExpired=${orders.expired} sessionsClosed=${orders.sessionsClosed}`);
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
