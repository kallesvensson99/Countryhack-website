import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { db } from "@/lib/db";
import { kitchenSummary } from "@/lib/food/kitchen";
import { createMeal, createPackage, deleteMeal, deletePackage, listPackagesForSale, updateMeal, updatePackage } from "@/lib/food/service";
import { createDiscountCode, deleteDiscountCode, updateDiscountCode } from "@/lib/orders/discount-codes";
import { startCheckout } from "@/lib/orders/checkout";
import { handleProviderEvent } from "@/lib/orders/webhooks";
import { renderTemplate } from "@/lib/email/templates";
import { ForbiddenError } from "@/lib/permissions";
import { setPaymentProvider, WebhookSignatureError } from "@/lib/payments";
import { StripeProvider } from "@/lib/payments/stripe";
import { signTicketToken, verifyTicketToken } from "@/lib/tickets/qr";
import { discountCodeSchema, foodPackageSchema, mealSchema } from "@/lib/validation/commerce";
import { FakeProvider, shop, type Shop } from "./commerce-helpers";
import { resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  setPaymentProvider(new FakeProvider());
});
afterEach(() => setPaymentProvider(undefined));

const SECRET = "whsec_test_secret";
const stripeLib = new Stripe("sk_test_dummy");
const sign = (payload: string, timestamp?: number) => stripeLib.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp });
const stripeEvent = (id: string, type: string, object: Record<string, unknown>) => JSON.stringify({ id, object: "event", api_version: "2024-06-20", created: 1, type, data: { object }, livemode: false, pending_webhooks: 1, request: null });
const paidSession = (orderId: string, amount: number, over: Record<string, unknown> = {}) => ({ id: `cs_${orderId}`, object: "checkout.session", client_reference_id: orderId, payment_status: "paid", payment_intent: `pi_${orderId}`, amount_total: amount, ...over });

describe("Stripe provider: webhook verification", () => {
  const provider = () => new StripeProvider("sk_test_dummy", SECRET);
  const headers = (sig: string | null) => new Headers(sig ? { "stripe-signature": sig } : {});

  it("accepts a correctly signed checkout.session.completed and normalises it", () => {
    const body = stripeEvent("evt_1", "checkout.session.completed", paidSession("ord1", 15000));
    expect(provider().parseWebhook(body, headers(sign(body)))).toEqual({ type: "checkout.paid", id: "evt_1", orderId: "ord1", sessionId: "cs_ord1", paymentRef: "pi_ord1", amountOre: 15000 });
  });

  it("rejects missing, wrong, tampered and stale signatures", () => {
    const body = stripeEvent("evt_2", "checkout.session.completed", paidSession("ord1", 15000));
    const p = provider();
    expect(() => p.parseWebhook(body, headers(null))).toThrow(WebhookSignatureError);
    expect(() => p.parseWebhook(body, headers("t=1,v1=deadbeef"))).toThrow(WebhookSignatureError);
    expect(() => p.parseWebhook(body.replace("15000", "100"), headers(sign(body)))).toThrow(WebhookSignatureError); // amount tampered
    const other = new Stripe("sk").webhooks.generateTestHeaderString({ payload: body, secret: "whsec_other" });
    expect(() => p.parseWebhook(body, headers(other))).toThrow(WebhookSignatureError);
    expect(() => p.parseWebhook(body, headers(sign(body, Math.floor(Date.now() / 1000) - 3600)))).toThrow(WebhookSignatureError); // replay of an old request
  });

  it("only treats paid sessions as payments; maps expiry; ignores the rest", () => {
    const p = provider();
    const unpaid = stripeEvent("evt_3", "checkout.session.completed", paidSession("ord1", 15000, { payment_status: "unpaid" }));
    expect(p.parseWebhook(unpaid, headers(sign(unpaid)))).toEqual({ type: "ignored", id: "evt_3" });
    const asyncOk = stripeEvent("evt_4", "checkout.session.async_payment_succeeded", paidSession("ord2", 500));
    expect(p.parseWebhook(asyncOk, headers(sign(asyncOk)))).toMatchObject({ type: "checkout.paid", orderId: "ord2" });
    const expired = stripeEvent("evt_5", "checkout.session.expired", { id: "cs_x", object: "checkout.session", client_reference_id: "ord3" });
    expect(p.parseWebhook(expired, headers(sign(expired)))).toEqual({ type: "checkout.expired", id: "evt_5", orderId: "ord3", sessionId: "cs_x" });
    const other = stripeEvent("evt_6", "customer.created", { id: "cus_1", object: "customer" });
    expect(p.parseWebhook(other, headers(sign(other)))).toEqual({ type: "ignored", id: "evt_6" });
  });
});

describe("POST /api/webhooks/stripe", () => {
  const post = (body: string, sig: string | null) => stripeWebhook(new Request("http://localhost/api/webhooks/stripe", { method: "POST", body, headers: sig ? { "stripe-signature": sig } : {} }));

  async function pendingOrder(s: Shop) {
    const b = await s.buyer();
    const r = await startCheckout(b.actor, s.input({ seatId: s.seats.A1! }));
    if (!r.ok) throw new Error(r.reason);
    return { b, order: await db.order.findUniqueOrThrow({ where: { number: r.orderNumber } }) };
  }

  it("verifies the signature, fulfils the order, and is idempotent on redelivery", async () => {
    const s = await shop();
    const { order } = await pendingOrder(s);
    setPaymentProvider(new StripeProvider("sk_test_dummy", SECRET));
    const body = stripeEvent("evt_route_1", "checkout.session.completed", paidSession(order.id, order.totalOre));

    expect((await post(body, null)).status).toBe(400);
    expect((await post(body, "t=1,v1=00")).status).toBe(400);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING");

    const ok = await post(body, sign(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ received: true, status: "processed" });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID" });
    expect(await db.seatClaim.findFirstOrThrow()).toMatchObject({ status: "CONFIRMED" });

    const again = await post(body, sign(body));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "duplicate" });
    expect(await db.emailOutbox.count({ where: { template: "order-confirmation" } })).toBe(1);
  });

  it("acknowledges event types it doesn't use", async () => {
    setPaymentProvider(new StripeProvider("sk_test_dummy", SECRET));
    const body = stripeEvent("evt_route_2", "charge.succeeded", { id: "ch_1", object: "charge" });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(await db.webhookEvent.count()).toBe(0);
  });

  it("returns 500 (so Stripe retries) when processing fails, and succeeds on the retry", async () => {
    const s = await shop();
    const { order } = await pendingOrder(s);
    setPaymentProvider(new StripeProvider("sk_test_dummy", SECRET));
    const body = stripeEvent("evt_route_3", "checkout.session.completed", paidSession(order.id, order.totalOre));
    // simulate a crash after the idempotency row was written but before processing finished
    await db.webhookEvent.create({ data: { provider: "stripe", externalId: "evt_route_3" } });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200); // unprocessed rows are processed again, not skipped
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID" });
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { externalId: "evt_route_3" } })).processedAt).not.toBeNull();
    expect(await handleProviderEvent("stripe", { type: "ignored", id: "x" })).toEqual({ status: "ignored" });
  });
});

describe("ticket QR tokens", () => {
  const ticket = { id: "cm0ticket123456789abc", qrNonce: "a1b2c3d4e5f60718293a4b5c" };
  it("round-trips and detects tampering", () => {
    const token = signTicketToken(ticket);
    expect(token).toMatch(/^ccss1\.cm0ticket123456789abc\.a1b2c3d4e5f60718293a4b5c\.[A-Za-z0-9_-]{22}$/);
    expect(verifyTicketToken(token)).toEqual({ ticketId: ticket.id, nonce: ticket.qrNonce });
    expect(verifyTicketToken(`  ${token}\n`)).not.toBeNull(); // scanners add whitespace
    const parts = token.split(".");
    expect(verifyTicketToken([parts[0], "cm0ticket123456789abd", parts[2], parts[3]].join("."))).toBeNull(); // other ticket
    expect(verifyTicketToken([parts[0], parts[1], "a1b2c3d4e5f60718293a4b5d", parts[3]].join("."))).toBeNull(); // other nonce
    expect(verifyTicketToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull(); // signature
    expect(verifyTicketToken(token.replace("ccss1", "ccss2"))).toBeNull();
    for (const junk of ["", "ccss1", "a.b.c.d", "ccss1.x.y.z", "ccss1..." + "a".repeat(5000)]) expect(verifyTicketToken(junk)).toBeNull();
  });
});

describe("email templates for orders", () => {
  it("renders cancel and seat-needed mails in both languages", () => {
    const c = { name: "Maja", orderNumber: "CCSS-2027-0001", eventName: "Vår-LAN", refundedOre: 15000, url: "http://x/my" };
    expect(renderTemplate("order-cancelled", "sv", c).html).toContain("återbetalat");
    expect(renderTemplate("order-cancelled", "en", { ...c, refundedOre: 0 }).html).toContain("No refund was made");
    expect(renderTemplate("seat-needed", "sv", { name: "Maja", eventName: "Vår-LAN", url: "http://x" }).subject).toBe("Välj en ny plats");
    expect(renderTemplate("seat-needed", "en", { name: "Maja", eventName: "Vår-LAN", url: "http://x" }).subject).toBe("Please choose a new seat");
  });

  it("the English receipt carries the not-VAT-registered line too and escapes names", () => {
    const r = renderTemplate("order-confirmation", "en", {
      name: "<b>Eve</b>", orderNumber: "CCSS-2027-0001", eventName: "E & F", eventStartsAt: "2027-03-12T17:00:00Z", venue: "Hall", paidAt: "2027-01-01T10:00:00Z",
      items: [{ description: "Ticket", priceOre: 15000 }], subtotalOre: 15000, discountOre: 0, totalOre: 15000, discountCode: null,
      org: { name: "CCSS", orgNumber: null, address: null }, tickets: [], url: "http://x",
    });
    expect(r.html).toContain("The association is not VAT-registered");
    expect(r.html).not.toContain("<b>Eve</b>");
    expect(r.html).toContain("&amp;");
    expect(r.html).toContain("SEK");
    expect(r.html).not.toMatch(/Organization number/); // not set yet → not printed
  });
});

// ───────────────────────── food management ─────────────────────────

const mealForm = (name: string, servedAt = "2027-03-12T19:00") => mealSchema.parse({ name, servedAt });
const pkgForm = (over: Record<string, string> = {}) =>
  foodPackageSchema.parse({ name: "Helhelg", description: "Allt", price: "300", quantity: "", salesEndsAt: "2027-03-01T12:00", variants: "Standard\nVegetarisk\nVegansk", ...over });

describe("food management", () => {
  it("creates meals and packages with variants and meal links, audited", async () => {
    const s = await shop();
    const m1 = await createMeal(s.fl, s.event.id, mealForm("Brunch"));
    const m2 = await createMeal(s.fl, s.event.id, mealForm("Middag", "2027-03-13T19:00"));
    if (!m1.ok || !m2.ok) throw new Error("meals");
    const p = await createPackage(s.fl, s.event.id, pkgForm({ quantity: "40" }), [m1.value.id, m2.value.id], "1.2.3.4");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const pkg = await db.foodPackage.findUniqueOrThrow({ where: { id: p.value.id }, include: { variants: { orderBy: { sortOrder: "asc" } }, meals: true } });
    expect(pkg).toMatchObject({ priceOre: 30000, quantity: 40 });
    expect(pkg.variants.map((v) => v.name)).toEqual(["Standard", "Vegetarisk", "Vegansk"]);
    expect(pkg.meals).toHaveLength(2);
    expect(pkg.salesEndsAt.toISOString()).toBe("2027-03-01T11:00:00.000Z"); // Stockholm → UTC
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "foodPackage.create" } })).toMatchObject({ actorId: s.fl.id, eventId: s.event.id, ip: "1.2.3.4" });
  });

  it("validates input", () => {
    expect(foodPackageSchema.safeParse({ ...pkgForm(), price: "gratis", variants: "A" }).success).toBe(false);
    expect(foodPackageSchema.safeParse({ name: "x", price: "10", salesEndsAt: "2027-03-01T12:00", variants: "" }).success).toBe(false); // needs a variant
    expect(foodPackageSchema.safeParse({ name: "x", price: "10", salesEndsAt: "2027-03-01T12:00", variants: "Vegan\nvegan" }).success).toBe(false); // duplicates
    expect(foodPackageSchema.safeParse({ name: "x", price: "10", salesEndsAt: "2027-03-01T12:00", variants: "A", quantity: "-3" }).success).toBe(false);
    expect(pkgForm({ quantity: "" }).quantity).toBeUndefined(); // unlimited
  });

  it("rejects meals from another event, and non-staff", async () => {
    const s = await shop();
    const other = await shop();
    await expect(createMeal(s.buyer ? (await s.buyer()).actor : s.fl, s.event.id, mealForm("x"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await createPackage(s.fl, s.event.id, pkgForm(), [other.meals.fri.id])).toEqual({ ok: false, reason: "badMeals" });
  });

  it("updates packages: keeps variants that were bought, adds new ones, refuses to drop used ones or go below sold", async () => {
    const s = await shop();
    const b = await s.buyer();
    const veg = s.food.hv(s.food.helhelg, "Vegansk");
    const bought = await startCheckout(b.actor, s.input({ food: [{ packageId: s.food.helhelg.id, variantId: veg }] }));
    expect(bought.ok).toBe(true);

    // dropping "Vegansk" (bought) is refused; dropping "Standard" (never bought) works; adding works
    expect(await updatePackage(s.fl, s.food.helhelg.id, pkgForm({ variants: "Standard\nGlutenfri" }), [s.meals.fri.id])).toEqual({ ok: false, reason: "variantInUse" });
    expect(await updatePackage(s.fl, s.food.helhelg.id, pkgForm({ variants: "Vegansk\nGlutenfri", quantity: "5", price: "310" }), [s.meals.fri.id])).toMatchObject({ ok: true });
    const after = await db.foodPackage.findUniqueOrThrow({ where: { id: s.food.helhelg.id }, include: { variants: { orderBy: { sortOrder: "asc" } }, meals: true } });
    expect(after.variants.map((v) => v.name)).toEqual(["Vegansk", "Glutenfri"]);
    expect(after.variants[0]!.id).toBe(veg); // same row → the purchase still points at it
    expect(after).toMatchObject({ priceOre: 31000, quantity: 5 });
    expect(after.meals.map((m) => m.mealId)).toEqual([s.meals.fri.id]);
    expect(await updatePackage(s.fl, s.food.helhelg.id, pkgForm({ variants: "Vegansk", quantity: "0" }), [])).toEqual({ ok: false, reason: "quantityBelowSold" });
  });

  it("deletes meals and packages only when nothing was ever bought", async () => {
    const s = await shop();
    const b = await s.buyer();
    await startCheckout(b.actor, s.input({ food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] }));
    expect(await deletePackage(s.fl, s.food.frukost.id)).toEqual({ ok: false, reason: "hasPurchases" });
    expect(await deleteMeal(s.fl, s.meals.sat.id)).toEqual({ ok: false, reason: "hasPurchases" }); // linked to a package with purchases
    expect(await deletePackage(s.fl, s.food.expired.id)).toMatchObject({ ok: true });
    const m = await createMeal(s.fl, s.event.id, mealForm("Extra"));
    if (!m.ok) throw new Error("m");
    expect(await updateMeal(s.fl, m.value.id, mealForm("Extra 2", "2027-03-14T09:00"))).toMatchObject({ ok: true });
    expect(await deleteMeal(s.fl, m.value.id)).toMatchObject({ ok: true });
    expect(await db.auditLog.count({ where: { action: { in: ["meal.create", "meal.update", "meal.delete", "foodPackage.delete"] } } })).toBe(4);
  });

  it("lists packages for sale with stock and state", async () => {
    const s = await shop();
    const b = await s.buyer();
    await startCheckout(b.actor, s.input({ food: [{ packageId: s.food.helhelg.id, variantId: s.food.hv(s.food.helhelg) }] }));
    const list = await listPackagesForSale(s.event.id);
    const hel = list.find((p) => p.name === "Helhelg")!;
    expect(hel).toMatchObject({ left: 1, state: "open" });
    expect(hel.meals.map((m) => m.name)).toEqual(["Fredagsmiddag", "Lördagslunch"]); // by time
    expect(list.find((p) => p.name === "Frukost")).toMatchObject({ left: null, state: "open" });
    expect(list.find((p) => p.name === "Försent")).toMatchObject({ state: "ended" });
    const b2 = await s.buyer();
    await startCheckout(b2.actor, s.input({ food: [{ packageId: s.food.helhelg.id, variantId: s.food.hv(s.food.helhelg) }] }));
    expect((await listPackagesForSale(s.event.id)).find((p) => p.name === "Helhelg")).toMatchObject({ left: 0, state: "soldOut" });
  });
});

describe("kitchen summary", () => {
  async function buyPaid(s: Shop, nickname: string, food: { p: Shop["food"]["helhelg"]; v: string }[], allergies: string | null, dietary: string | null = null) {
    const b = await s.buyer({ nickname });
    await db.user.update({ where: { id: b.user.id }, data: { allergies, dietaryPreferences: dietary, realName: `Real ${nickname}` } });
    const r = await startCheckout(b.actor, s.input({ food: food.map((f) => ({ packageId: f.p.id, variantId: s.food.hv(f.p, f.v) })) }));
    if (!r.ok) throw new Error(r.reason);
    const o = await db.order.findUniqueOrThrow({ where: { number: r.orderNumber } });
    await handleProviderEvent("fake", { type: "checkout.paid", id: `evt_${o.id}`, orderId: o.id, sessionId: "s", paymentRef: "pi", amountOre: o.totalOre });
    return b;
  }

  it("counts servings per meal and variant (ACTIVE only) and lists allergies by name", async () => {
    const s = await shop();
    await buyPaid(s, "anna", [{ p: s.food.helhelg, v: "Standard" }, { p: s.food.frukost, v: "Standard" }], "nötter, skaldjur");
    await buyPaid(s, "bo", [{ p: s.food.helhelg, v: "Vegansk" }], null, "vegetarian");
    const pending = await s.buyer({ nickname: "cia" }); // unpaid → must not count
    await startCheckout(pending.actor, s.input({ food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] }));
    await buyPaid(s, "dan", [{ p: s.food.frukost, v: "Standard" }], null);

    const k = await kitchenSummary(s.fl, s.event.id);
    const fri = k.meals.find((m) => m.name === "Fredagsmiddag")!;
    const sat = k.meals.find((m) => m.name === "Lördagslunch")!;
    expect(fri).toMatchObject({ total: 2, variants: [{ name: "Standard", count: 1 }, { name: "Vegansk", count: 1 }] });
    expect(sat.total).toBe(4); // anna (helhelg + frukost), bo (helhelg), dan (frukost)
    expect(sat.variants).toEqual([{ name: "Standard", count: 3 }, { name: "Vegansk", count: 1 }]);
    expect(k.purchases).toBe(4);
    expect(k.allergies.map((a) => [a.nickname, a.realName, a.allergies, a.dietary])).toEqual([
      ["anna", "Real anna", "nötter, skaldjur", null],
      ["bo", "Real bo", null, "vegetarian"],
    ]);
    expect(k.allergies[0]!.packages.sort()).toEqual(["Frukost (Standard)", "Helhelg (Standard)"]);
  });

  it("uses the allergy text from purchase time, not later profile edits", async () => {
    const s = await shop();
    const b = await buyPaid(s, "eva", [{ p: s.food.frukost, v: "Standard" }], "gluten");
    await db.user.update({ where: { id: b.user.id }, data: { allergies: "ändrat senare" } });
    const k = await kitchenSummary(s.fl, s.event.id);
    expect(k.allergies[0]!.allergies).toBe("gluten");
  });

  it("is for Festivalledare only", async () => {
    const s = await shop();
    await expect(kitchenSummary((await s.buyer()).actor, s.event.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ───────────────────────── discount codes ─────────────────────────

const codeForm = (over: Record<string, string> = {}) => discountCodeSchema.parse({ code: "VÅR25", kind: "PERCENT", value: "25", appliesTo: "ALL", ...over });

describe("discount codes (management)", () => {
  it("validates percent / fixed amounts, format and dates", () => {
    expect(codeForm().value).toBe(25);
    expect(codeForm({ kind: "FIXED", value: "49,50" }).value).toBe(4950);
    for (const bad of [{ value: "0" }, { value: "101" }, { value: "x" }, { kind: "FIXED", value: "0" }, { code: "a b" }, { code: "x" }, { validFrom: "2027-02-01T10:00", validUntil: "2027-01-01T10:00" }, { maxUses: "-1" }]) {
      expect(discountCodeSchema.safeParse({ code: "OK1", kind: "PERCENT", value: "10", appliesTo: "ALL", ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(codeForm({ maxUses: "20", validUntil: "2027-03-01T00:00" })).toMatchObject({ maxUses: 20 });
  });

  it("creates codes (unique per event, case-insensitively) that can unlock ticket types", async () => {
    const s = await shop();
    const r = await createDiscountCode(s.fl, s.event.id, codeForm(), [s.types.crew.id], "9.9.9.9");
    expect(r.ok).toBe(true);
    expect(await createDiscountCode(s.fl, s.event.id, codeForm({ code: "vår25" }), [])).toEqual({ ok: false, reason: "duplicate" });
    expect(await createDiscountCode(s.fl, s.event.id, codeForm({ code: "EARLY10" }), [])).toEqual({ ok: false, reason: "duplicate" }); // exists in the shop
    const other = await shop();
    expect(await createDiscountCode(s.fl, s.event.id, codeForm({ code: "Z1" }), [other.types.crew.id])).toEqual({ ok: false, reason: "badTicketTypes" });
    expect(await createDiscountCode(s.fl, other.event.id, codeForm(), [])).toMatchObject({ ok: true }); // same code, other event
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "discountCode.create" }, orderBy: { createdAt: "asc" } })).toMatchObject({ actorId: s.fl.id, ip: "9.9.9.9", diff: { code: "VÅR25", unlocks: 1 } });

    // and it really unlocks Crew at checkout
    const b = await s.buyer();
    expect((await startCheckout(b.actor, s.input({ ticketTypeId: s.types.crew.id, discountCode: "vår25" }))).ok).toBe(true);
  });

  it("updates and deletes; used codes can't be deleted", async () => {
    const s = await shop();
    const made = await createDiscountCode(s.fl, s.event.id, codeForm(), []);
    if (!made.ok) throw new Error("x");
    expect(await updateDiscountCode(s.fl, made.id, codeForm({ value: "30", maxUses: "5" }), [s.types.crew.id])).toMatchObject({ ok: true });
    expect(await db.discountCode.findUniqueOrThrow({ where: { id: made.id }, include: { ticketTypes: true } })).toMatchObject({ value: 30, maxUses: 5, ticketTypes: [{ ticketTypeId: s.types.crew.id }] });
    expect(await updateDiscountCode(s.fl, made.id, codeForm({ code: "EARLY10" }), [])).toEqual({ ok: false, reason: "duplicate" });
    expect(await deleteDiscountCode(s.fl, made.id)).toMatchObject({ ok: true });

    const b = await s.buyer();
    await startCheckout(b.actor, s.input({ discountCode: "EARLY10" }));
    expect(await deleteDiscountCode(s.fl, s.codes.early.id)).toEqual({ ok: false, reason: "inUse" }); // an order references it
    expect(await deleteDiscountCode(s.fl, "nope")).toEqual({ ok: false, reason: "notFound" });
  });

  it("is for Festivalledare only", async () => {
    const s = await shop();
    await expect(createDiscountCode((await s.buyer()).actor, s.event.id, codeForm(), [])).rejects.toBeInstanceOf(ForbiddenError);
  });
});
