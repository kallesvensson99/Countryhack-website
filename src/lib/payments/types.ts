/**
 * Payment provider abstraction. Stripe is the only real implementation today;
 * a different provider only has to implement this interface (and normalise its webhooks to ProviderEvent).
 */

export interface CheckoutLine {
  name: string;
  /** Amount for this line AFTER discount, in öre. */
  amountOre: number;
}

export interface CreateSessionInput {
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  locale: "sv" | "en";
  lines: CheckoutLine[];
  totalOre: number;
  successUrl: string;
  cancelUrl: string;
  /** When the provider should stop accepting payment for this session. */
  expiresAt: Date;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
}

export interface RefundInput {
  /** Provider reference of the successful charge (Stripe: payment_intent id). */
  paymentRef: string;
  amountOre: number;
  /** Retrying the same request must not refund twice. */
  idempotencyKey: string;
}

/** Provider webhooks, normalised. `id` is the provider's unique event id (used for idempotency). */
export type ProviderEvent =
  | { type: "checkout.paid"; id: string; orderId: string; sessionId: string; paymentRef: string; amountOre: number }
  | { type: "checkout.expired"; id: string; orderId: string | null; sessionId: string }
  | { type: "ignored"; id: string };

export class WebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export interface PaymentProvider {
  readonly name: string;
  createCheckoutSession(input: CreateSessionInput): Promise<CheckoutSession>;
  /** Stop accepting payment for a session. Must succeed (idempotently) if it's already closed. */
  expireSession(sessionId: string): Promise<void>;
  refund(input: RefundInput): Promise<{ refundId: string }>;
  /** Verifies the signature and normalises the event. Throws WebhookSignatureError when it doesn't verify. */
  parseWebhook(rawBody: string, headers: Headers): ProviderEvent;
}
