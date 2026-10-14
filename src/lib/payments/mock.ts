import { randomBytes } from "node:crypto";
import { env } from "../env";
import type { CheckoutSession, CreateSessionInput, PaymentProvider, ProviderEvent, RefundInput } from "./types";
import { WebhookSignatureError } from "./types";

/**
 * Development / test provider (PAYMENT_PROVIDER=mock): the "checkout page" is /dev/mock-pay inside this app,
 * where you press Pay or Cancel. It feeds the same webhook handler as Stripe, so the whole flow can be
 * exercised without a Stripe account. It refuses to run for a public (non-localhost) APP_URL.
 */
export class MockProvider implements PaymentProvider {
  readonly name = "mock";

  constructor() {
    const host = new URL(env().APP_URL).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      throw new Error(`The mock payment provider only works on localhost, not ${host}. Set PAYMENT_PROVIDER=stripe.`);
    }
  }

  async createCheckoutSession(input: CreateSessionInput): Promise<CheckoutSession> {
    const sessionId = `mock_cs_${input.orderId}`;
    const q = new URLSearchParams({ order: input.orderId, success: input.successUrl, cancel: input.cancelUrl });
    return { sessionId, url: `${env().APP_URL.replace(/\/$/, "")}/${input.locale}/dev/mock-pay?${q}` };
  }

  async expireSession(): Promise<void> {}

  async refund(input: RefundInput): Promise<{ refundId: string }> {
    return { refundId: `mock_re_${input.idempotencyKey.replace(/[^a-z0-9]/gi, "")}_${randomBytes(3).toString("hex")}` };
  }

  parseWebhook(): ProviderEvent {
    throw new WebhookSignatureError("The mock provider has no webhooks");
  }
}
