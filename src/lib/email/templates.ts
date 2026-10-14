import { formatSek } from "../money";

export type Locale = "sv" | "en";

export interface ConfirmationPayload {
  name: string;
  orderNumber: string;
  eventName: string;
  eventStartsAt: string;
  venue: string;
  paidAt: string;
  items: { description: string; priceOre: number }[];
  subtotalOre: number;
  discountOre: number;
  totalOre: number;
  discountCode: string | null;
  org: { name: string; orgNumber: string | null; address: string | null };
  tickets: { id: string; typeName: string; seat: string | null; qrToken: string }[];
  url: string;
}

export interface TemplatePayloads {
  "verify-email": { name: string; url: string };
  "reset-password": { name: string; url: string };
  broadcast: { subject: string; body: string; eventName?: string };
  "order-confirmation": ConfirmationPayload;
  "order-cancelled": { name: string; orderNumber: string; eventName: string; refundedOre: number; url: string };
  "seat-needed": { name: string; eventName: string; url: string };
}

export type TemplateName = keyof TemplatePayloads;

export interface Rendered {
  subject: string;
  html: string;
  text: string;
  /** Inline QR codes: the outbox turns each `qr` text into a PNG attached under this Content-ID. */
  attachments?: { filename: string; cid: string; qr: string }[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function layout(locale: Locale, bodyHtml: string): string {
  const footer = locale === "sv" ? "Cable connectors spelsällskap (CCSS)" : "Cable connectors gaming society (CCSS)";
  return `<!doctype html><html lang="${locale}"><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#111">${bodyHtml}<hr style="margin-top:32px;border:none;border-top:1px solid #ddd"><p style="color:#666;font-size:12px">${footer}</p></body></html>`;
}

function button(url: string, label: string): string {
  return `<p><a href="${esc(url)}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${esc(label)}</a></p><p style="font-size:13px;color:#555">${esc(url)}</p>`;
}

type Renderer<K extends TemplateName> = (p: TemplatePayloads[K], l: Locale) => Rendered;

const renderers: { [K in TemplateName]: Renderer<K> } = {
  "verify-email": (p, l) => {
    const t =
      l === "sv"
        ? { subject: "Bekräfta din e-postadress", hi: `Hej ${p.name}!`, line: "Klicka på knappen för att bekräfta din e-postadress. Länken gäller i 24 timmar.", cta: "Bekräfta e-post" }
        : { subject: "Confirm your email address", hi: `Hi ${p.name}!`, line: "Click the button to confirm your email address. The link is valid for 24 hours.", cta: "Confirm email" };
    return {
      subject: t.subject,
      html: layout(l, `<h2>${esc(t.hi)}</h2><p>${t.line}</p>${button(p.url, t.cta)}`),
      text: `${t.hi}\n\n${t.line}\n\n${p.url}`,
    };
  },
  "reset-password": (p, l) => {
    const t =
      l === "sv"
        ? { subject: "Återställ ditt lösenord", hi: `Hej ${p.name}!`, line: "Vi fick en begäran om att återställa ditt lösenord. Länken gäller i 1 timme. Om det inte var du kan du ignorera det här mejlet.", cta: "Välj nytt lösenord" }
        : { subject: "Reset your password", hi: `Hi ${p.name}!`, line: "We received a request to reset your password. The link is valid for 1 hour. If this wasn't you, ignore this email.", cta: "Choose a new password" };
    return {
      subject: t.subject,
      html: layout(l, `<h2>${esc(t.hi)}</h2><p>${t.line}</p>${button(p.url, t.cta)}`),
      text: `${t.hi}\n\n${t.line}\n\n${p.url}`,
    };
  },
  "order-confirmation": (p, l) => {
    const sv = l === "sv";
    const money = (o: number) => formatSek(o, l);
    const when = new Intl.DateTimeFormat(sv ? "sv-SE" : "en-GB", { timeZone: "Europe/Stockholm", dateStyle: "full", timeStyle: "short" }).format(new Date(p.eventStartsAt));
    const paid = new Intl.DateTimeFormat(sv ? "sv-SE" : "en-GB", { timeZone: "Europe/Stockholm", dateStyle: "medium", timeStyle: "short" }).format(new Date(p.paidAt));
    const t = sv
      ? { subject: `Orderbekräftelse ${p.orderNumber} – ${p.eventName}`, hi: `Tack ${p.name}!`, lead: "Din beställning är betald. Här är ditt kvitto och din biljett.", ticket: "Din biljett", seat: "Plats", noSeat: "Välj plats på eventets sida", receipt: "Kvitto", order: "Ordernummer", date: "Datum", sub: "Delsumma", disc: "Rabatt", total: "Totalt", vat: "Föreningen är inte momsregistrerad", org: "Organisationsnummer", show: "Visa i Mina sidor", code: "Rabattkod" }
      : { subject: `Order confirmation ${p.orderNumber} – ${p.eventName}`, hi: `Thank you ${p.name}!`, lead: "Your order is paid. Here is your receipt and your ticket.", ticket: "Your ticket", seat: "Seat", noSeat: "Choose a seat on the event page", receipt: "Receipt", order: "Order number", date: "Date", sub: "Subtotal", disc: "Discount", total: "Total", vat: "The association is not VAT-registered", org: "Organization number", show: "View in My pages", code: "Discount code" };
    const orgLines = [p.org.name, p.org.orgNumber ? `${t.org}: ${p.org.orgNumber}` : null, p.org.address].filter(Boolean) as string[];
    const rows = p.items.map((i) => `<tr><td style="padding:4px 0">${esc(i.description)}</td><td style="text-align:right">${money(i.priceOre)}</td></tr>`).join("");
    const tickets = p.tickets.map((tk, n) => `<div style="margin:16px 0;padding:12px;border:1px solid #ddd;border-radius:8px"><strong>${t.ticket}: ${esc(tk.typeName)}</strong><br>${tk.seat ? `${t.seat}: <strong>${esc(tk.seat)}</strong>` : esc(t.noSeat)}<br><img src="cid:ticket-${n}" alt="QR" width="180" height="180" style="margin-top:8px"></div>`).join("");
    const html = layout(l, `<h2>${esc(t.hi)}</h2><p>${t.lead}</p><p><strong>${esc(p.eventName)}</strong><br>${esc(when)}<br>${esc(p.venue)}</p>${tickets}<h3>${t.receipt}</h3><p style="font-size:13px;color:#555">${t.order}: ${esc(p.orderNumber)}<br>${t.date}: ${esc(paid)}</p><table style="width:100%;border-collapse:collapse">${rows}${p.discountOre > 0 ? `<tr><td>${t.disc}${p.discountCode ? ` (${esc(p.discountCode)})` : ""}</td><td style="text-align:right">−${money(p.discountOre)}</td></tr>` : ""}<tr style="border-top:1px solid #333"><td><strong>${t.total}</strong></td><td style="text-align:right"><strong>${money(p.totalOre)}</strong></td></tr></table><p style="font-size:13px">${esc(t.vat)}</p><p style="font-size:12px;color:#555">${orgLines.map(esc).join("<br>")}</p>${button(p.url, t.show)}`);
    const text = [t.hi, "", p.eventName, when, p.venue, "", `${t.order}: ${p.orderNumber}`, ...p.items.map((i) => `${i.description}: ${money(i.priceOre)}`), ...(p.discountOre > 0 ? [`${t.disc}: -${money(p.discountOre)}`] : []), `${t.total}: ${money(p.totalOre)}`, t.vat, ...orgLines, "", p.url].join("\n");
    return { subject: t.subject, html, text, attachments: p.tickets.map((tk, n) => ({ filename: `ticket-${n + 1}.png`, cid: `ticket-${n}`, qr: tk.qrToken })) };
  },
  "order-cancelled": (p, l) => {
    const sv = l === "sv";
    const refund = p.refundedOre > 0 ? (sv ? `Vi har återbetalat ${formatSek(p.refundedOre, l)}. Pengarna syns på ditt kort inom några bankdagar.` : `We have refunded ${formatSek(p.refundedOre, l)}. The money appears on your card within a few banking days.`) : sv ? "Ingen återbetalning gjordes." : "No refund was made.";
    const t = sv ? { subject: `Din beställning ${p.orderNumber} är avbokad`, line: `Din beställning ${p.orderNumber} för ${p.eventName} har avbokats av en festivalledare. Biljett, plats och mat är avbokade.`, cta: "Mina sidor" } : { subject: `Your order ${p.orderNumber} has been cancelled`, line: `Your order ${p.orderNumber} for ${p.eventName} was cancelled by an organizer. Ticket, seat and food are cancelled.`, cta: "My pages" };
    return { subject: t.subject, html: layout(l, `<h2>${esc(p.name)}</h2><p>${esc(t.line)}</p><p>${esc(refund)}</p>${button(p.url, t.cta)}`), text: `${t.line}\n\n${refund}\n\n${p.url}` };
  },
  "seat-needed": (p, l) => {
    const t = l === "sv" ? { subject: "Välj en ny plats", line: `Din betalning för ${p.eventName} kom in, men platsen du valde hann bli upptagen. Din biljett är giltig – välj en ny plats på eventets sida.`, cta: "Välj plats" } : { subject: "Please choose a new seat", line: `Your payment for ${p.eventName} went through, but the seat you picked was taken in the meantime. Your ticket is valid – please choose a new seat on the event page.`, cta: "Choose seat" };
    return { subject: t.subject, html: layout(l, `<h2>${esc(p.name)}</h2><p>${esc(t.line)}</p>${button(p.url, t.cta)}`), text: `${t.line}\n\n${p.url}` };
  },
  broadcast: (p, l) => {
    // Why they get this mail (they didn't ask for it, so say so)
    const why = p.eventName ? (l === "sv" ? `Du får det här meddelandet för att du har en biljett till ${p.eventName}.` : `You are receiving this message because you have a ticket to ${p.eventName}.`) : "";
    return {
      subject: p.subject,
      html: layout(l, `<h2>${esc(p.subject)}</h2>${esc(p.body).replace(/\n/g, "<br>")}${why ? `<p style="margin-top:24px;font-size:12px;color:#666">${esc(why)}</p>` : ""}`),
      text: why ? `${p.body}\n\n--\n${why}` : p.body,
    };
  },
};

export function renderTemplate<K extends TemplateName>(name: K, locale: Locale, payload: TemplatePayloads[K]): Rendered {
  return (renderers[name] as Renderer<K>)(payload, locale);
}
