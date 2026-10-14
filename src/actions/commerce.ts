"use server";

import { getLocale } from "next-intl/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/auth/service";
import { assertCan } from "@/lib/permissions";
import { previewQuote, startCheckout } from "@/lib/orders/checkout";
import { revalidatePath } from "next/cache";
import { parseSekToOre } from "@/lib/money";
import { cancelOrder } from "@/lib/orders/refund";
import type { Quote } from "@/lib/orders/quote";
import type { ActionState } from "@/lib/validation/account";
import { checkoutSchema } from "@/lib/validation/commerce";

export interface PreviewResponse {
  ok: boolean;
  /** i18n key (under "checkout.err_*") when not ok */
  error?: string;
  lines: { description: string; priceOre: number }[];
  subtotalOre: number;
  discountOre: number;
  totalOre: number;
  codeApplied: string | null;
  /** Ticket types the entered code unlocks (hidden or code-only), for the buy form. */
  unlocked: { id: string; name: string; description: string; priceOre: number; includesSeat: boolean; zoneIds: string[] }[];
}

const empty: PreviewResponse = { ok: false, lines: [], subtotalOre: 0, discountOre: 0, totalOre: 0, codeApplied: null, unlocked: [] };

/** Live price + validation for the cart. Same rules as checkout, but nothing is written. */
export async function previewCartAction(raw: unknown): Promise<PreviewResponse> {
  const actor = await getCurrentUser();
  const parsed = checkoutSchema.safeParse(raw);
  if (!parsed.success || !actor) return { ...empty, error: "checkout.err_invalid" };
  assertCan(actor, parsed.data.ticketTypeId ? "ticket:buy" : "food:buy");

  const q = await previewQuote(actor, parsed.data);
  if (!q.ok) {
    // An unknown / expired code shouldn't hide the rest of the cart: report it, with the code-free price.
    const base = q.reason.startsWith("code") ? await previewQuote(actor, { ...parsed.data, discountCode: null }) : null;
    if (base?.ok) return { ...(await toResponse(base.quote, false)), error: `checkout.err_${q.reason}` };
    return { ...empty, error: `checkout.err_${q.reason}` };
  }
  return toResponse(q.quote, true);
}

async function toResponse(quote: Quote, codeValid: boolean): Promise<PreviewResponse> {
  {
    const unlocked = quote.unlockedTypeIds.length
      ? await db.ticketType.findMany({ where: { id: { in: quote.unlockedTypeIds }, eventId: quote.event.id }, include: { zones: true }, orderBy: { sortOrder: "asc" } })
      : [];
    return {
      ok: true,
      lines: quote.lines.map((l) => ({ description: l.description, priceOre: l.priceOre })),
      subtotalOre: quote.subtotalOre,
      discountOre: quote.discountOre,
      totalOre: quote.totalOre,
      codeApplied: codeValid ? (quote.code?.code ?? null) : null,
      unlocked: unlocked.map((t) => ({ id: t.id, name: t.name, description: t.description, priceOre: t.priceOre, includesSeat: t.includesSeat, zoneIds: t.zones.map((z) => z.zoneId) })),
    };
  }
}

export type CheckoutResponse = { ok: true; url: string } | { ok: false; error: string; detail?: string };

export async function checkoutAction(raw: unknown): Promise<CheckoutResponse> {
  const actor = await getCurrentUser();
  const parsed = checkoutSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "checkout.err_invalid" };
  assertCan(actor, parsed.data.ticketTypeId ? "ticket:buy" : "food:buy");
  const locale = (await getLocale()) === "en" ? "en" : "sv";

  const r = await startCheckout(actor, { ...parsed.data, locale }, { ip: await getClientIp() });
  if (!r.ok) return { ok: false, error: `checkout.err_${r.reason}`, detail: r.detail };
  if (r.kind === "free") return { ok: true, url: appUrl(locale, `/my/orders/${r.orderNumber}?checkout=success`) };
  return { ok: true, url: r.url };
}

const id = z.string().min(1).max(60);

/** Festivalledare: cancel a paid order, optionally refunding only part of it. */
export async function cancelOrderAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "order:cancel");
  const orderId = id.safeParse(fd.get("orderId"));
  if (!orderId.success) return { message: "messages.invalidInput" };
  const mode = String(fd.get("mode") ?? "full");
  let refundOre: number | undefined;
  if (mode === "partial") {
    const ore = parseSekToOre(String(fd.get("amount") ?? ""));
    if (ore === null) return { errors: { amount: "validation.priceInvalid" }, values: { amount: String(fd.get("amount") ?? "") } };
    refundOre = ore;
  } else if (mode === "none") {
    refundOre = 0;
  }
  const r = await cancelOrder(actor, orderId.data, { refundOre, ip: await getClientIp() });
  if (!r.ok) {
    const map = { notFound: "messages.notFound", notPaid: "messages.orderNotPaid", invalidAmount: "messages.refundInvalidAmount", providerError: "messages.refundProviderError", noCharge: "messages.refundNoCharge" } as const;
    return { message: map[r.reason] };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: r.status === "REFUNDED" ? "messages.orderRefunded" : "messages.orderCancelled" };
}
