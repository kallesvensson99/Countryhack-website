import { getPaymentProvider, WebhookSignatureError } from "@/lib/payments";
import { handleProviderEvent } from "@/lib/orders/webhooks";

export const dynamic = "force-dynamic";

/**
 * Stripe → us. No cookies or Origin involved: the request is authenticated by Stripe's signature over the
 * raw body (so this route is deliberately exempt from the same-origin check). Must read the *raw* text.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const provider = getPaymentProvider();
  let event;
  try {
    event = provider.parseWebhook(raw, req.headers);
  } catch (e) {
    if (e instanceof WebhookSignatureError) return new Response("Invalid signature", { status: 400 });
    throw e;
  }
  try {
    const r = await handleProviderEvent(provider.name, event);
    return Response.json({ received: true, status: r.status });
  } catch (e) {
    console.error("[webhook] processing failed", e);
    return new Response("Processing failed", { status: 500 }); // Stripe will retry
  }
}
