import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetRateLimits } from "./helpers";

const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });
test.beforeEach(resetRateLimits);
test.afterAll(() => db.$disconnect());

const PASSWORD = "Password123!";
const SLUG = "ccss-lan-hostlan";

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/sv/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Lösenord").fill(PASSWORD);
  await page.getByRole("button", { name: "Logga in" }).click();
  await expect(page).toHaveURL(/\/sv\/profile/);
}

const seat = (page: Page, label: string) => page.locator(`svg [role="button"][aria-label^="${label} "]`);

/** Removes everything a previous run left for this member at the seeded event, so tests can be repeated. */
async function wipe(email: string) {
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
  const orders = await db.order.findMany({ where: { userId: user.id, eventId: event.id }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  await db.seatClaim.deleteMany({ where: { ticket: { userId: user.id, eventId: event.id } } });
  await db.foodPurchase.deleteMany({ where: { ticket: { userId: user.id, eventId: event.id } } });
  await db.ticket.deleteMany({ where: { userId: user.id, eventId: event.id } });
  await db.payment.deleteMany({ where: { orderId: { in: ids } } });
  await db.order.deleteMany({ where: { id: { in: ids } } });
  await db.discountCode.updateMany({ where: { eventId: event.id }, data: { usedCount: 0 } });
  return { user, event };
}

test.describe("buying", () => {
  test("ticket + food + discount code + seat → pay → receipt, QR and My pages; then Festivalledare see it in the kitchen summary and refund part of it", async ({ page }) => {
    test.setTimeout(120_000); // one long journey through the whole shop
    const startedAt = new Date(); // one long journey through the whole shop
    const { user, event } = await wipe("member@ccss.test");
    await login(page, "member@ccss.test");
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByRole("heading", { name: "Köp biljett" })).toBeVisible();

    // ticket + live price
    await page.getByRole("radio", { name: /Standard med plats/ }).check();
    await expect(page.getByText("Att betala").locator("..")).toContainText("150 kr");
    await expect(page.getByText("Föreningen är inte momsregistrerad")).toBeVisible();

    // discount code
    await page.getByLabel("Har du en rabattkod?").fill("nope");
    await page.getByRole("button", { name: "Använd kod" }).click();
    await expect(page.getByText("Rabattkoden finns inte.")).toBeVisible();
    await page.getByLabel("Har du en rabattkod?").fill("early10");
    await page.getByRole("button", { name: "Använd kod" }).click();
    await expect(page.getByText("Koden EARLY10 är använd.")).toBeVisible();
    await expect(page.getByText("Att betala").locator("..")).toContainText("135 kr");

    // food with a variant
    await page.getByRole("checkbox", { name: /Frukostpaket/ }).check();
    await page.getByLabel("Variant").selectOption({ label: "Vegansk" });
    await expect(page.getByText("Att betala").locator("..")).toContainText("243 kr"); // (150 + 120) − 10 %

    // seat chosen as part of checkout; VIP seats are not selectable for a Standard ticket
    await expect(page.getByRole("button", { name: "Gå till betalning" })).toBeDisabled(); // a seat is required
    await expect(page.getByText("Välj en plats på kartan för att kunna gå vidare till betalning.")).toBeVisible();
    await expect(seat(page, "V1")).toHaveAttribute("aria-disabled", "true");
    await seat(page, "A5").click();
    await expect(page.getByText("Du har valt plats A5.")).toBeVisible();

    await page.getByRole("button", { name: "Gå till betalning" }).click();
    await expect(page.getByRole("heading", { name: "Betala (test)" })).toBeVisible();
    await expect(page.getByText("243 kr").first()).toBeVisible();
    const pending = await db.order.findFirstOrThrow({ where: { userId: user.id, eventId: event.id, status: "PENDING" }, include: { tickets: { include: { seatClaim: true } } } });
    expect(pending.totalOre).toBe(24300);
    expect(pending.tickets[0]!.seatClaim).toMatchObject({ status: "HELD" });

    // abandon the payment: nothing is charged, the order stays pending, the seat stays held
    await page.getByRole("button", { name: "Avbryt" }).click();
    await expect(page).toHaveURL(/checkout=cancelled/);
    await expect(page.getByText("Betalningen avbröts")).toBeVisible();
    await expect(page.getByText("Du har en obetald beställning")).toBeVisible();
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");

    // start over (replaces the unpaid order) and pay this time
    await page.getByRole("radio", { name: /Standard med plats/ }).check();
    await page.getByRole("checkbox", { name: /^Fredagsmiddag/ }).check();
    await seat(page, "A5").click();
    await expect(page.getByText("Du har valt plats A5.")).toBeVisible();
    await page.getByRole("button", { name: "Gå till betalning" }).click();
    await page.getByRole("button", { name: "Betala", exact: true }).click();

    await expect(page).toHaveURL(/\/sv\/my\/orders\/CCSS-\d{4}-\d{4}\?checkout=success/);
    await expect(page.getByText("Tack! Din betalning är mottagen.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Kvitto CCSS-");
    await expect(page.getByText("Föreningen är inte momsregistrerad")).toBeVisible();
    await expect(page.getByText("Cable connectors spelsällskap (CCSS)").first()).toBeVisible();
    await expect(page.getByRole("img", { name: /QR-kod/ })).toBeVisible();
    await expect(page.getByText("Plats: A5")).toBeVisible();
    await expect(page.getByText("Fredagsmiddag – Standard")).toBeVisible();
    // the replaced order is expired, the seat is now confirmed for the new one
    expect(await db.order.count({ where: { userId: user.id, eventId: event.id, status: "EXPIRED" } })).toBe(1);
    expect(await db.order.count({ where: { userId: user.id, eventId: event.id, status: "PAID" } })).toBe(1);
    const claims = await db.seatClaim.findMany({ where: { ticket: { userId: user.id, eventId: event.id } } });
    expect(claims).toMatchObject([{ status: "CONFIRMED", expiresAt: null }]);
    expect(await db.emailOutbox.count({ where: { to: "member@ccss.test", template: "order-confirmation" } })).toBeGreaterThanOrEqual(1);

    // My pages
    await page.goto("/sv/my");
    await expect(page.getByRole("img", { name: /QR-kod för din biljett till Countryhack/ })).toBeVisible();
    await expect(page.getByText("Plats:").first()).toBeVisible();
    await expect(page.getByText("Fredagsmiddag – Standard")).toBeVisible();

    // adds food later (food-only order on the existing ticket); already-bought packages aren't offered again
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByRole("heading", { name: "Lägg till mat" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^Fredagsmiddag/ })).toHaveCount(0);
    await page.getByRole("checkbox", { name: /Frukostpaket/ }).check();
    await page.getByLabel("Variant").selectOption({ label: "Vegetarisk" });
    await page.getByRole("button", { name: "Gå till betalning" }).click();
    await page.getByRole("button", { name: "Betala", exact: true }).click();
    await expect(page.getByText("Tack! Din betalning är mottagen.")).toBeVisible();
    expect(await db.ticket.count({ where: { userId: user.id, eventId: event.id, status: "ACTIVE" } })).toBe(1);

    // ---- Festivalledare
    await login(page, "leader@ccss.test");
    await page.goto(`/sv/manage/events/${event.id}/kitchen`);
    await expect(page.getByRole("heading", { name: /Köksöversikt/ })).toBeVisible();
    const sat = page.locator("article", { hasText: "Lördagsfrukost" });
    await expect(sat.getByRole("row", { name: "Vegetarisk 1" })).toBeVisible();
    await expect(page.getByText("Fredagsmiddag").first()).toBeVisible();

    await page.goto(`/sv/manage/events/${event.id}/orders?status=PAID`);
    const firstOrder = await db.order.findFirstOrThrow({ where: { userId: user.id, status: "PAID" }, orderBy: { createdAt: "asc" } });
    const row = page.locator("details", { hasText: firstOrder.number });
    await row.locator("summary").click();
    await row.getByRole("radio", { name: "Ett delbelopp" }).check();
    await row.getByLabel("Belopp (kr)").fill("50");
    page.once("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: "Avboka beställningen" }).click();
    // the order leaves the "Betald" filter once cancelled, so its inline message goes with it: check the result instead
    await expect(page.locator("details", { hasText: firstOrder.number })).toHaveCount(0);

    const cancelled = await db.order.findUniqueOrThrow({ where: { id: firstOrder.id }, include: { payments: true, tickets: true } });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.payments.find((p) => p.kind === "REFUND")).toMatchObject({ amountOre: 5000, status: "succeeded" });
    expect(cancelled.tickets[0]!.status).toBe("CANCELLED");
    expect(await db.seatClaim.count({ where: { ticket: { userId: user.id, eventId: event.id } } })).toBe(0);
    expect(await db.emailOutbox.count({ where: { to: "member@ccss.test", template: "order-cancelled", createdAt: { gte: startedAt } } })).toBe(1);

    // the member's page reflects it, and they can buy again
    await login(page, "member@ccss.test");
    await page.goto(`/sv/my/orders/${firstOrder.number}`);
    await expect(page.getByText("Beställningen är avbokad.")).toBeVisible();
    await expect(page.getByText("Återbetalat")).toBeVisible();
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByRole("heading", { name: "Köp biljett" })).toBeVisible();
  });

  test("a Crew ticket needs the code, and with the 100 % code the order completes without payment", async ({ page }) => {
    const { user } = await wipe("minor@ccss.test");
    await login(page, "minor@ccss.test");
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByRole("radio", { name: /Crew/ })).toHaveCount(0); // hidden

    await page.getByLabel("Har du en rabattkod?").fill("CREW");
    await page.getByRole("button", { name: "Använd kod" }).click();
    await expect(page.getByText("Koden CREW är använd.")).toBeVisible();
    await page.getByRole("radio", { name: /Crew/ }).check();
    await expect(page.getByText("Inget att betala")).toBeVisible();
    await expect(page.getByRole("button", { name: "Slutför beställningen" })).toBeDisabled(); // even a free Crew ticket needs a seat
    await seat(page, "B2").click();
    await page.getByRole("button", { name: "Slutför beställningen" }).click();

    await expect(page).toHaveURL(/\/my\/orders\/CCSS-/);
    await expect(page.getByText("Tack! Din betalning är mottagen.")).toBeVisible();
    const order = await db.order.findFirstOrThrow({ where: { userId: user.id }, include: { tickets: true } });
    expect(order).toMatchObject({ status: "PAID", totalOre: 0 });
    expect(order.tickets[0]!.status).toBe("ACTIVE");
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(0); // the provider was never involved
  });

  test("visitors and unverified members are told what to do instead of seeing a buy form", async ({ page }) => {
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByText("Logga in eller skapa ett konto för att köpa biljett.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Gå till betalning" })).toHaveCount(0);

    await login(page, "unverified@ccss.test");
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByText("Bekräfta din e-postadress")).toBeVisible();
    await expect(page.getByRole("button", { name: "Gå till betalning" })).toHaveCount(0);
  });

  test("the buy form fits a phone and is usable by keyboard", async ({ page }) => {
    await wipe("member@ccss.test");
    await login(page, "member@ccss.test");
    await page.goto(`/sv/events/${SLUG}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    const radio = page.getByRole("radio", { name: /VIP-plats/ });
    await radio.focus();
    await page.keyboard.press("Space");
    await expect(radio).toBeChecked();
    await expect(page.getByText("Att betala").locator("..")).toContainText("250 kr");
  });

  test("members can't open someone else's receipt or the management pages", async ({ page }) => {
    const { user } = await wipe("member@ccss.test");
    const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
    const order = await db.order.create({ data: { number: `E2E-PRIV-${Date.now()}`, userId: user.id, eventId: event.id, status: "PAID", subtotalOre: 100, totalOre: 100, expiresAt: new Date(), paidAt: new Date() } });
    await login(page, "minor@ccss.test");
    await page.goto(`/sv/my/orders/${order.number}`);
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
    for (const p of ["orders", "kitchen", "food", "codes"]) {
      await page.goto(`/sv/manage/events/${event.id}/${p}`);
      await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
    }
    await db.order.delete({ where: { id: order.id } });
  });
});

test.describe("management (Festivalledare)", () => {
  test("creates a meal, a food package with variants, and a discount code that unlocks a ticket type", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "management screens are desktop tools");
    const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
    const stamp = Date.now();
    await login(page, "leader@ccss.test");

    await page.goto(`/sv/manage/events/${event.id}/food`);
    const newMeal = page.locator("div.card", { hasText: "Ny måltid" });
    await newMeal.getByLabel("Namn").fill(`Pizza ${stamp}`);
    await newMeal.getByLabel("Serveras").fill("2027-06-01T20:00");
    await newMeal.getByRole("button", { name: "Lägg till måltid" }).click();
    await expect(newMeal.getByText("Måltiden är sparad.")).toBeVisible();

    const newPkg = page.locator("div.card", { hasText: "Nytt matpaket" });
    await newPkg.getByLabel("Namn").fill(`Pizzakväll ${stamp}`);
    await newPkg.getByLabel("Pris (kr)").fill("79,50");
    await newPkg.getByLabel("Beställ senast").fill("2027-05-25T12:00");
    await newPkg.getByLabel("Varianter").fill("Margherita\nVegansk");
    await newPkg.getByLabel(`Pizza ${stamp}`, { exact: false }).check();
    await newPkg.getByRole("button", { name: "Lägg till matpaket" }).click();
    await expect(newPkg.getByText("Matpaketet är sparat.")).toBeVisible();
    const pkg = await db.foodPackage.findFirstOrThrow({ where: { name: `Pizzakväll ${stamp}` }, include: { variants: true, meals: true } });
    expect(pkg).toMatchObject({ priceOre: 7950 });
    expect(pkg.variants.map((v) => v.name).sort()).toEqual(["Margherita", "Vegansk"]);
    expect(pkg.meals).toHaveLength(1);

    await page.goto(`/sv/manage/events/${event.id}/codes`);
    const newCode = page.locator("section", { hasText: "Ny rabattkod" });
    await newCode.getByLabel("Kod", { exact: true }).fill(`TEST${stamp}`);
    await newCode.getByLabel("Värde").fill("250");
    await newCode.getByRole("button", { name: "Skapa kod" }).click();
    await expect(newCode.getByText("Ange ett heltal mellan 1 och 100.")).toBeVisible(); // percent out of range
    await newCode.getByLabel("Värde").fill("25");
    await newCode.getByLabel("Crew").check();
    await newCode.getByRole("button", { name: "Skapa kod" }).click();
    await expect(newCode.getByText("Rabattkoden är sparad.")).toBeVisible();
    const code = await db.discountCode.findFirstOrThrow({ where: { code: `TEST${stamp}` }, include: { ticketTypes: true } });
    expect(code).toMatchObject({ kind: "PERCENT", value: 25 });
    expect(code.ticketTypes).toHaveLength(1);
    await db.discountCode.delete({ where: { id: code.id } });
  });
});
