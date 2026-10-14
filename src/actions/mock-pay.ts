"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getPaymentProvider } from "@/lib/payments";
import { handleProviderEvent } from "@/lib/orders/webhooks";

/** Only our own URLs: the mock checkout page must not become an open redirect. */
function ownUrl(u: unknown): string {
  const base = new URL(env().APP_URL).origin;
  if (typeof u !== "string" || new URL(u, base).origin !== base) throw new Error("Bad redirect URL");
  return u;
}

function assertMock() {
  if (env().PAYMENT_PROVIDER !== "mock") throw new Error("The mock payment page is disabled");
  getPaymentProvider(); // throws unless APP_URL is localhost
}

/** "Pay" on the fake checkout page: delivers the same event a real provider's webhook would. */
export async function mockPayAction(fd: FormData): Promise<void> {
  assertMock();
  const orderId = String(fd.get("order") ?? "");
  const success = ownUrl(fd.get("success"));
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  await handleProviderEvent("mock", {
    type: "checkout.paid",
    id: `mock_evt_${orderId}_${randomBytes(4).toString("hex")}`,
    orderId,
    sessionId: `mock_cs_${orderId}`,
    paymentRef: `mock_pi_${orderId}`,
    amountOre: order.totalOre,
  });
  redirect(success);
}

export async function mockCancelAction(fd: FormData): Promise<void> {
  assertMock();
  redirect(ownUrl(fd.get("cancel")));
}
