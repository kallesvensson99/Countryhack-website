import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });
import { resetRateLimits } from "./helpers";
test.beforeEach(resetRateLimits);
test.afterAll(() => db.$disconnect());

const PASSWORD = "Password123!";
const SLUG = "ccss-lan-hostlan";

async function login(page: Page, email: string) {
  await page.goto("/sv/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Lösenord").fill(PASSWORD);
  await page.getByRole("button", { name: "Logga in" }).click();
  await expect(page).toHaveURL(/\/sv\/profile/);
}

const seat = (page: Page, label: string) => page.locator(`svg [role="button"][aria-label^="${label} "]`);

/** Gives `email` an ACTIVE ticket of the given type for the seeded event, replacing any earlier test data. */
async function giveTicket(email: string, typeName: string) {
  const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const type = await db.ticketType.findFirstOrThrow({ where: { eventId: event.id, name: typeName } });
  await db.seatClaim.deleteMany({ where: { ticket: { userId: user.id, eventId: event.id } } });
  await db.ticket.deleteMany({ where: { userId: user.id, eventId: event.id } });
  const order = await db.order.create({ data: { number: `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, userId: user.id, eventId: event.id, status: "PAID", subtotalOre: 0, totalOre: 0, expiresAt: new Date(), paidAt: new Date() } });
  return db.ticket.create({ data: { eventId: event.id, userId: user.id, ticketTypeId: type.id, orderId: order.id, status: "ACTIVE", qrNonce: "e2e" } });
}

test.describe("booking a seat", () => {
  test.beforeEach(async () => {
    await db.seatClaim.deleteMany({});
  });

  test("visitors see the legend and taken seats (with nicknames, as the event allows) but can't pick", async ({ page }) => {
    const ture = await giveTicket("minor@ccss.test", "Standard med plats");
    const a1 = await db.seat.findFirstOrThrow({ where: { label: "A1", chart: { event: { slug: SLUG } } } });
    await db.seatClaim.create({ data: { seatId: a1.id, ticketId: ture.id, status: "CONFIRMED" } });

    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByRole("heading", { name: "Platskarta" })).toBeVisible();
    await expect(page.getByText("59 av 60 platser är lediga.")).toBeVisible();
    await expect(seat(page, "A1")).toHaveAttribute("aria-label", /Upptagen · ture/);
    await expect(seat(page, "A2")).toHaveAttribute("aria-label", /Ledig/);
    await expect(seat(page, "A2")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Logga in och köp en biljett med plats")).toBeVisible();
    // legend uses text next to every glyph, not colour alone
    for (const text of ["Ledig", "Din plats", "Upptagen", "Spärrad", "Reserverad"]) await expect(page.getByRole("list").getByText(text, { exact: true }).first()).toBeVisible();
    // clicking does nothing for visitors
    await seat(page, "A2").click({ force: true }); // aria-disabled: Playwright would wait forever otherwise
    await expect(page.getByText("Vill du ha plats")).toHaveCount(0);
  });

  test("a member with a Standard ticket picks, then changes seat on the map; other zones are off limits", async ({ page }) => {
    await giveTicket("member@ccss.test", "Standard med plats");
    await login(page, "member@ccss.test");
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByText("Du har en biljett med plats")).toBeVisible();

    // VIP seats aren't for this ticket
    await expect(seat(page, "V1")).toHaveAttribute("aria-disabled", "true");
    await seat(page, "V1").click({ force: true });
    await expect(page.getByText("Välj en ledig plats på kartan eller i listan.")).toBeVisible();

    // pick A3
    await seat(page, "A3").click();
    await expect(page.getByText("Vill du ha plats A3?")).toBeVisible();
    await page.getByRole("button", { name: "Välj den här platsen" }).click();
    await expect(page.getByText("Din plats är vald.")).toBeVisible();
    await expect(seat(page, "A3")).toHaveAttribute("aria-label", /Din plats/);
    await expect(page.getByText("Du har redan en plats")).toBeVisible();
    const claims = await db.seatClaim.findMany({ include: { seat: true } });
    expect(claims.map((c) => [c.seat.label, c.status])).toEqual([["A3", "CONFIRMED"]]);

    // change to A4: A3 becomes free again
    await seat(page, "A4").click();
    await expect(page.getByText("Vill du byta till plats A4?")).toBeVisible();
    await page.getByRole("button", { name: "Byt till den här platsen" }).click();
    await expect(page.getByText("Din plats är bytt.")).toBeVisible();
    await expect(seat(page, "A4")).toHaveAttribute("aria-label", /Din plats/);
    await expect(seat(page, "A3")).toHaveAttribute("aria-label", /Ledig/);
    expect(await db.seatClaim.count()).toBe(1);
  });

  test("keyboard and list view: filter by zone, free only, pick with the keyboard; lost races show a clear message", async ({ page }) => {
    await giveTicket("member@ccss.test", "Standard med plats");
    const other = await giveTicket("minor@ccss.test", "Standard med plats");
    await login(page, "member@ccss.test");
    await page.goto(`/sv/events/${SLUG}`);

    // keyboard on the map: focus a seat, press Enter
    await seat(page, "B2").focus();
    await expect(page.getByText(/B2 · Standard · Ledig/).last()).toBeVisible(); // info line follows focus
    await page.keyboard.press("Enter");
    await expect(page.getByText("Vill du ha plats B2?")).toBeVisible();

    // list view
    await page.getByRole("button", { name: "Lista" }).click();
    await page.getByLabel("Zon").selectOption({ label: "Standard" });
    await page.getByLabel("Visa bara lediga platser").check();
    await expect(page.getByText("50 platser")).toBeVisible();
    await page.getByRole("radio", { name: /^C5 /}).check();
    await expect(page.getByText("Vill du ha plats C5?")).toBeVisible();

    // someone grabs C5 first
    const c5 = await db.seat.findFirstOrThrow({ where: { label: "C5", chart: { event: { slug: SLUG } } } });
    await db.seatClaim.create({ data: { seatId: c5.id, ticketId: other.id, status: "CONFIRMED" } });
    await page.getByRole("button", { name: "Välj den här platsen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Någon hann före" })).toBeVisible();
    expect(await db.seatClaim.count({ where: { seatId: c5.id } })).toBe(1);

    // VIP zone isn't pickable for this ticket
    await page.getByLabel("Zon").selectOption({ label: "VIP" });
    await expect(page.getByRole("radio", { name: /^V1 / })).toBeDisabled();
  });

  test("a member without a seat ticket gets an explanation; the map fits on a phone", async ({ page }) => {
    await giveTicket("member@ccss.test", "Besökare / utan plats");
    await login(page, "member@ccss.test");
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByText("Din biljett inkluderar ingen plats.").first()).toBeVisible();
    await expect(seat(page, "A5")).toHaveAttribute("aria-disabled", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test("zoom controls work", async ({ page }) => {
    await page.goto(`/sv/events/${SLUG}`);
    await expect(page.getByText("100%")).toBeVisible();
    await page.getByRole("button", { name: "Zooma in" }).click();
    await expect(page.getByText("140%")).toBeVisible();
    await page.getByRole("button", { name: "Hela kartan" }).click();
    await expect(page.getByText("100%")).toBeVisible();
  });
});

test.describe("chart editor (Festivalledare)", () => {
  test("creates a chart, edits it, handles duplicates and booked seats, saves a template", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "the editor is a desktop tool");
    const leader = await db.user.findUniqueOrThrow({ where: { email: "leader@ccss.test" } });
    const stamp = Date.now();
    const event = await db.event.create({
      data: { slug: `editor-${stamp}`, name: `Editor ${stamp}`, description: "x", venueName: "v", address: "a", startsAt: new Date("2027-08-01T16:00:00Z"), endsAt: new Date("2027-08-02T16:00:00Z"), registrationOpensAt: new Date("2027-01-01T00:00:00Z"), registrationClosesAt: new Date("2027-07-30T00:00:00Z"), status: "PUBLISHED", createdById: leader.id },
    });

    await login(page, "leader@ccss.test");
    await page.goto(`/sv/manage/events/${event.id}/chart`);
    await expect(page.getByText("Eventet har ingen platskarta än.")).toBeVisible();
    await page.getByLabel("Börja från").selectOption({ label: "Tom karta" });
    await page.getByRole("button", { name: "Skapa platskarta" }).click();
    await expect(page.getByRole("group", { name: "Redigeringsyta för platskartan" })).toBeVisible();

    // add a row of 5
    await page.getByLabel("Antal platser").first().fill("5");
    await page.getByLabel("Prefix").first().fill("R");
    await page.getByRole("button", { name: "Lägg till rad" }).click();
    const seats = page.locator('svg [data-key^="s:"]');
    await expect(seats).toHaveCount(5);
    await expect(page.getByText("Osparade ändringar")).toBeVisible();
    await expect(page.getByText("5 platser och 0 objekt markerade")).toBeVisible(); // new items are selected

    // drag the (selected) row 80px to the right: positions snap to the grid
    const first = seats.first();
    const before = await first.getAttribute("transform");
    const box = (await first.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 5, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 5, { steps: 4 });
    await page.mouse.up();
    const after = await first.getAttribute("transform");
    expect(after).not.toBe(before);
    const [bx] = /translate\(([-\d.]+)/.exec(before!)!.slice(1).map(Number);
    const [ax] = /translate\(([-\d.]+)/.exec(after!)!.slice(1).map(Number);
    expect((ax! - bx!) % 20).toBe(0);
    expect(ax! - bx!).toBeGreaterThanOrEqual(60);

    // add a stage and a second zone
    await page.getByRole("button", { name: "Scen", exact: true }).click();
    await page.getByRole("button", { name: "Lägg till zon" }).click();

    await page.getByRole("button", { name: "Spara", exact: true }).click();
    await expect(page.getByText("Platskartan är sparad.")).toBeVisible();
    await expect(page.getByText("Allt sparat")).toBeVisible();
    expect(await db.seat.count({ where: { chart: { eventId: event.id } } })).toBe(5);
    expect(await db.chartObject.count({ where: { chart: { eventId: event.id } } })).toBe(1);
    expect(await db.seatZone.count({ where: { chart: { eventId: event.id } } })).toBe(2);

    // rename a seat to a duplicate: warning + save disabled
    await page.keyboard.press("Escape");
    await seats.nth(1).click();
    await page.getByLabel("Platsnamn").fill("R1");
    await expect(page.getByRole("alert").filter({ hasText: "Platsnamn måste vara unika" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Spara", exact: true })).toBeDisabled();
    await page.getByLabel("Platsnamn").fill("Z9");
    await expect(page.getByRole("button", { name: "Spara", exact: true })).toBeEnabled();

    // undo / redo
    await page.getByRole("button", { name: "Ångra" }).click();
    await expect(seats.nth(1)).toHaveAttribute("aria-label", /Plats Z|Plats R/);
    await page.getByRole("button", { name: "Gör om" }).click();
    await expect(page.locator('svg [aria-label^="Plats Z9"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Spara", exact: true }).click();
    await expect(page.getByText("Platskartan är sparad.")).toBeVisible();
    await page.reload();
    await expect(page.locator('svg [aria-label^="Plats Z9"]')).toHaveCount(1); // persisted

    // a booked seat can't be deleted
    const z9 = await db.seat.findFirstOrThrow({ where: { label: "Z9", chart: { eventId: event.id } } });
    const member = await db.user.findUniqueOrThrow({ where: { email: "member@ccss.test" } });
    const type = await db.ticketType.create({ data: { eventId: event.id, name: "T", priceOre: 0, quantity: 5 } });
    const order = await db.order.create({ data: { number: `E2E-ED-${stamp}`, userId: member.id, eventId: event.id, subtotalOre: 0, totalOre: 0, expiresAt: new Date() } });
    const ticket = await db.ticket.create({ data: { eventId: event.id, userId: member.id, ticketTypeId: type.id, orderId: order.id, status: "ACTIVE", qrNonce: "n" } });
    await db.seatClaim.create({ data: { seatId: z9.id, ticketId: ticket.id, status: "CONFIRMED" } });
    await page.locator('svg [aria-label^="Plats Z9"]').click();
    await page.getByRole("button", { name: "Ta bort", exact: true }).click();
    await page.getByRole("button", { name: "Spara", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "bokade och kan inte tas bort" })).toContainText("Z9");
    expect(await db.seat.count({ where: { chart: { eventId: event.id } } })).toBe(5); // unchanged

    // save as template, then it shows up on the templates page and in "create chart"
    await page.reload();
    await page.getByLabel("Mallens namn").fill(`Mall ${stamp}`);
    await page.getByRole("button", { name: "Spara som mall" }).click();
    await expect(page.getByText("Mallen är sparad.")).toBeVisible();
    await page.goto("/sv/manage/templates");
    await expect(page.getByText(`Mall ${stamp}`)).toBeVisible();
  });

  test("creating a chart from the seeded template gives 60 seats", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "the editor is a desktop tool");
    const leader = await db.user.findUniqueOrThrow({ where: { email: "leader@ccss.test" } });
    const stamp = Date.now();
    const event = await db.event.create({
      data: { slug: `tpl-${stamp}`, name: `Tpl ${stamp}`, description: "x", venueName: "v", address: "a", startsAt: new Date("2027-08-01T16:00:00Z"), endsAt: new Date("2027-08-02T16:00:00Z"), registrationOpensAt: new Date("2027-01-01T00:00:00Z"), registrationClosesAt: new Date("2027-07-30T00:00:00Z"), createdById: leader.id },
    });
    await login(page, "leader@ccss.test");
    await page.goto(`/sv/manage/events/${event.id}/chart`);
    await page.getByLabel("Börja från").selectOption({ label: "Standardmall (60 platser) (60 platser)" });
    await page.getByRole("button", { name: "Skapa platskarta" }).click();
    await expect(page.locator('svg [data-key^="s:"]')).toHaveCount(60);
    await expect(page.locator('svg [data-key^="o:"]')).toHaveCount(5);

    // select everything with the keyboard, then clear it
    await page.locator('svg [data-key^="s:"]').first().focus();
    await page.keyboard.press("Control+a");
    await expect(page.getByText("60 platser och 5 objekt markerade")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Inget markerat.")).toBeVisible();
  });

  test("members can't open the editor or templates", async ({ page }) => {
    await login(page, "member@ccss.test");
    for (const p of ["/sv/manage/templates", `/sv/manage/events/whatever/chart`]) {
      await page.goto(p);
      await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
    }
  });
});
