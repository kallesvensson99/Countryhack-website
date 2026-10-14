import { env } from "../env";
import { MockProvider } from "./mock";
import { StripeProvider } from "./stripe";
import type { PaymentProvider } from "./types";

export * from "./types";

let provider: PaymentProvider | undefined;

export function getPaymentProvider(): PaymentProvider {
  return (provider ??= env().PAYMENT_PROVIDER === "mock" ? new MockProvider() : new StripeProvider());
}

/** Test hook. */
export function setPaymentProvider(p: PaymentProvider | undefined) {
  provider = p;
}
