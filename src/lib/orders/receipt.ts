import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { appUrl } from "../auth/service";
import { signTicketToken } from "../tickets/qr";

type Client = Prisma.TransactionClient | typeof db;

export interface Receipt {
  orderId: string;
  number: string;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  buyerName: string;
  eventName: string;
  eventSlug: string;
  eventStartsAt: Date;
  venue: string;
  items: { description: string; priceOre: number }[];
  subtotalOre: number;
  discountOre: number;
  totalOre: number;
  discountCode: string | null;
  refundedOre: number;
  org: { name: string; orgNumber: string | null; address: string | null };
  tickets: { id: string; typeName: string; seat: string | null; qrToken: string }[];
}

/** Everything a receipt shows. No VAT breakdown: the association isn't VAT-registered. */
export async function loadReceipt(client: Client, orderId: string): Promise<Receipt | null> {
  const order = await client.order.findUnique({
    where: { id: orderId },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      user: true,
      event: true,
      discountCode: true,
      payments: true,
      tickets: { include: { ticketType: true, seatClaim: { include: { seat: true } } } },
    },
  });
  if (!order) return null;
  const org = (await client.orgSettings.findFirst()) ?? { name: "Cable connectors spelsällskap (CCSS)", orgNumber: null, address: null };
  return {
    orderId: order.id,
    number: order.number,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    buyerName: order.user.realName,
    eventName: order.event.name,
    eventSlug: order.event.slug,
    eventStartsAt: order.event.startsAt,
    venue: `${order.event.venueName}, ${order.event.address}`,
    items: order.items.map((i) => ({ description: i.description, priceOre: i.unitPriceOre * i.quantity })),
    subtotalOre: order.subtotalOre,
    discountOre: order.discountOre,
    totalOre: order.totalOre,
    discountCode: order.discountCode?.code ?? null,
    refundedOre: order.payments.filter((p) => p.kind === "REFUND" && p.status === "succeeded").reduce((s, p) => s + p.amountOre, 0),
    org: { name: org.name, orgNumber: org.orgNumber, address: org.address },
    tickets: order.tickets
      .filter((t) => t.status !== "CANCELLED")
      .map((t) => ({ id: t.id, typeName: t.ticketType.name, seat: t.seatClaim?.seat.label ?? null, qrToken: signTicketToken(t) })),
  };
}

/** JSON-safe payload for the confirmation email (dates as ISO strings). */
export function confirmationPayload(r: Receipt, locale: string) {
  return {
    name: r.buyerName,
    orderNumber: r.number,
    eventName: r.eventName,
    eventStartsAt: r.eventStartsAt.toISOString(),
    venue: r.venue,
    paidAt: (r.paidAt ?? r.createdAt).toISOString(),
    items: r.items,
    subtotalOre: r.subtotalOre,
    discountOre: r.discountOre,
    totalOre: r.totalOre,
    discountCode: r.discountCode,
    org: r.org,
    tickets: r.tickets,
    url: appUrl(locale, `/my/orders/${r.number}`),
  };
}
