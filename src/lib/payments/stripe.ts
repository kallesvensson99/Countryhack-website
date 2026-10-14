import Stripe from "stripe";
import { env } from "../env";
import type { CheckoutSession, CreateSessionInput, PaymentProvider, ProviderEvent, RefundInput } from "./types";
import { WebhookSignatureError } from "./types";

/** Stripe Checkout (hosted page) + webhooks. Currency is always SEK. */
export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  private stripe: Stripe;

  constructor(secretKey = env().STRIPE_SECRET_KEY, private webhookSecret = env().STRIPE_WEBHOOK_SECRET) {
    if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not set");
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2 });
  }

  async createCheckoutSession(input: CreateSessionInput): Promise<CheckoutSession> {
    // Stripe only accepts sessions that live 30 min – 24 h. The order itself expires at input.expiresAt;
    // the worker explicitly closes the session then, so a slightly longer session is harmless.
    const minExpiry = Date.now() + 31 * 60_000;
    const expiresAt = Math.floor(Math.max(input.expiresAt.getTime(), minExpiry) / 1000);
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: input.orderId,
        customer_email: input.customerEmail,
        locale: input.locale === "sv" ? "sv" : "en",
        line_items: input.lines
          .filter((l) => l.amountOre > 0)
          .map((l) => ({ quantity: 1, price_data: { currency: "sek", unit_amount: l.amountOre, product_data: { name: l.name } } })),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: expiresAt,
        metadata: { orderId: input.orderId, orderNumber: input.orderNumber },
        payment_intent_data: { metadata: { orderId: input.orderId, orderNumber: input.orderNumber } },
      },
      { idempotencyKey: `checkout-${input.orderId}` },
    );
    if (!session.url) throw new Error("Stripe returned no checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async expireSession(sessionId: string): Promise<void> {
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
    } catch (e) {
      // Already expired or completed: nothing left to close.
      if (e instanceof Stripe.errors.StripeInvalidRequestError && /expired|complete/i.test(e.message)) return;
      throw e;
    }
  }

  async refund(input: RefundInput): Promise<{ refundId: string }> {
    const r = await this.stripe.refunds.create({ payment_intent: input.paymentRef, amount: input.amountOre }, { idempotencyKey: input.idempotencyKey });
    return { refundId: r.id };
  }

  parseWebhook(rawBody: string, headers: Headers): ProviderEvent {
    const signature = headers.get("stripe-signature");
    if (!signature || !this.webhookSecret) throw new WebhookSignatureError("Missing signature or secret");
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (e) {
      throw new WebhookSignatureError(e instanceof Error ? e.message : undefined);
    }

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const s = event.data.object as Stripe.Checkout.Session;
      const orderId = s.client_reference_id ?? s.metadata?.orderId;
      const paymentRef = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id;
      if (s.payment_status === "paid" && orderId && paymentRef) {
        return { type: "checkout.paid", id: event.id, orderId, sessionId: s.id, paymentRef, amountOre: s.amount_total ?? -1 };
      }
      return { type: "ignored", id: event.id };
    }
    if (event.type === "checkout.session.expired") {
      const s = event.data.object as Stripe.Checkout.Session;
      return { type: "checkout.expired", id: event.id, orderId: s.client_reference_id ?? s.metadata?.orderId ?? null, sessionId: s.id };
    }
    return { type: "ignored", id: event.id };
  }
}
