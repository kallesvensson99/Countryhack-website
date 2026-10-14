import { createHmac } from "node:crypto";
import QRCode from "qrcode";
import { env } from "../env";
import { safeEqual } from "../auth/tokens";

/**
 * Ticket QR payload: `ccss1.<ticketId>.<nonce>.<signature>`
 * signature = base64url(HMAC-SHA256(APP_SECRET, "ccss1.<ticketId>.<nonce>")) (first 22 chars = 132 bits).
 * The nonce is per ticket (Ticket.qrNonce), so a leaked token can be invalidated by rotating the nonce.
 */
const PREFIX = "ccss1";

function sign(ticketId: string, nonce: string): string {
  return createHmac("sha256", env().APP_SECRET).update(`${PREFIX}.${ticketId}.${nonce}`).digest("base64url").slice(0, 22);
}

export function signTicketToken(ticket: { id: string; qrNonce: string }): string {
  return `${PREFIX}.${ticket.id}.${ticket.qrNonce}.${sign(ticket.id, ticket.qrNonce)}`;
}

/** Returns the ticket id and nonce if the signature is valid; the caller must still compare the nonce with the database. */
export function verifyTicketToken(token: string): { ticketId: string; nonce: string } | null {
  const parts = token.trim().split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, ticketId, nonce, sig] = parts as [string, string, string, string];
  if (!/^[a-z0-9]{10,40}$/.test(ticketId) || !/^[a-f0-9]{8,64}$/.test(nonce)) return null;
  return safeEqual(sig, sign(ticketId, nonce)) ? { ticketId, nonce } : null;
}

export function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 360 });
}

export function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 2, width: 360 });
}
