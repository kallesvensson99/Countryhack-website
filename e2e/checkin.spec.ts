import { expect, test, type Page } from "@playwright/test";
import { db, makeAttendee, resetRateLimits, SLUG } from "./helpers";

test.beforeEach(resetRateLimits);

const PASSWORD = "Password123!";

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/sv/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Lösenord").fill(PASSWORD);
  await page.getByRole("button", { name: "Logga in" }).click();
  await expect(page).toHaveURL(/\/sv\/profile/);
}

async function openCheckin(page: Page) {
  const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
  await login(page, "leader@ccss.test");
  await page.goto(`/sv/manage/events/${event.id}/checkin`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Incheckning");
  return event;
}

const search = async (page: Page, q: string) => {
  await page.getByLabel("Sök namn, nickname eller ordernummer").fill(q);
  await page.getByRole("button", { name: "Sök", exact: true }).click();
};

test.describe("check-in at the door", () => {
  test("search → card → check in → undo, with allergies and per-meal collection", async ({ page }) => {
    const { ticket } = await makeAttendee("member@ccss.test", { allergies: "nötter", food: true });
    await openCheckin(page);

    await search(page, "maja");
    await page.getByRole("button", { name: /maja Maja Medlem/ }).click();
    const card = page.getByRole("article", { name: "maja" });
    await expect(card.getByRole("heading", { name: "Maja Medlem" })).toBeVisible();
    await expect(card.getByText("Allergier:")).toBeVisible();
    await expect(card.getByText("nötter")).toBeVisible();
    await expect(card.getByText("Frukostpaket – Standard")).toBeVisible();
    await expect(card.getByText("UNDER 18 ÅR")).toHaveCount(0);

    // meals are collected one at a time
    await card.getByRole("button", { name: "Markera Lördagsfrukost som hämtad" }).click();
    await expect(card.getByRole("button", { name: /Ångra hämtning av Lördagsfrukost/ })).toContainText("Hämtad (frida)");
    await expect(card.getByRole("button", { name: "Markera Söndagsfrukost som hämtad" })).toBeVisible();
    expect(await db.mealCollection.count({ where: { foodPurchase: { ticketId: ticket.id } } })).toBe(1);

    // check in
    await card.getByRole("button", { name: "Checka in" }).click();
    await expect(page.getByText("Incheckad!")).toBeVisible();
    await expect(card.getByText(/Incheckad .* av frida/)).toBeVisible();
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).checkedInAt).not.toBeNull();

    // the search list now shows the badge
    await search(page, "maja");
    await expect(page.getByRole("button", { name: /maja Maja Medlem/ })).toContainText("Incheckad");

    // undo (confirm dialog)
    await page.getByRole("button", { name: /maja Maja Medlem/ }).click();
    page.once("dialog", (d) => void d.accept());
    await card.getByRole("button", { name: "Ångra incheckning" }).click();
    await expect(card.getByRole("button", { name: "Checka in" })).toBeVisible();
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).checkedInAt).toBeNull();
  });

  test("warns when someone else already checked the person in", async ({ page }) => {
    const { ticket } = await makeAttendee("member@ccss.test");
    const other = await db.user.findUniqueOrThrow({ where: { email: "admin@ccss.test" } });
    await openCheckin(page);
    await search(page, "maja");
    await page.getByRole("button", { name: /maja Maja Medlem/ }).click();
    await expect(page.getByRole("button", { name: "Checka in" })).toBeVisible();

    // another crew member scans the same person a moment earlier
    await db.ticket.update({ where: { id: ticket.id }, data: { checkedInAt: new Date(), checkedInById: other.id } });
    await page.getByRole("button", { name: "Checka in" }).click();
    await expect(page.getByRole("status").filter({ hasText: "redan incheckad" })).toBeVisible();
    await expect(page.getByText(/Incheckad .* av admin/)).toBeVisible();
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).checkedInById).toBe(other.id); // untouched
  });

  test("a minor shows a red warning with the guardian's name and phone", async ({ page }) => {
    await makeAttendee("minor@ccss.test");
    await openCheckin(page);
    await search(page, "ture");
    await page.getByRole("button", { name: /ture Ture Tonåring/ }).click();
    const warn = page.getByRole("alert").filter({ hasText: "UNDER 18 ÅR" });
    await expect(warn).toContainText("Greta Tonåring");
    await expect(warn.getByRole("link", { name: "+46 70 123 45 67" })).toHaveAttribute("href", "tel:+46701234567");
  });

  test("a pasted ticket code works like a scan; garbage and foreign codes are rejected", async ({ page }) => {
    process.env.APP_SECRET = "e2e-secret-e2e-secret-e2e-secret-123456"; // same secret as the server under test
    process.env.APP_URL = "http://localhost:3100";
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/ccss_test";
    const { signTicketToken } = await import("../src/lib/tickets/qr");
    const { ticket } = await makeAttendee("member@ccss.test");
    await openCheckin(page);

    await search(page, "ccss1.nonsense.abcdef.ghijkl");
    await expect(page.getByRole("alert").filter({ hasText: "Ogiltig biljettkod." })).toBeVisible();

    const good = signTicketToken(ticket);
    await search(page, good);
    await expect(page.getByRole("heading", { name: "Maja Medlem" })).toBeVisible();

    // the same code with a broken signature
    await search(page, good.slice(0, -3) + "AAA");
    await expect(page.getByRole("alert").filter({ hasText: "Ogiltig biljettkod." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Maja Medlem" })).toHaveCount(0);
  });

  test("unpaid, refunded and unknown people can't be checked in; members and admins can't open the page", async ({ page }) => {
    await makeAttendee("member@ccss.test");
    await db.ticket.updateMany({ where: { user: { email: "member@ccss.test" }, event: { slug: SLUG } }, data: { status: "CANCELLED" } });
    await openCheckin(page);
    await search(page, "maja");
    await expect(page.getByText("Ingen träff.")).toBeVisible();

    const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
    for (const email of ["member@ccss.test", "admin@ccss.test"]) {
      await login(page, email);
      for (const p of ["checkin", "attendees", "stats", "broadcast"]) {
        await page.goto(`/sv/manage/events/${event.id}/${p}`);
        await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
      }
      expect((await page.request.get(`/api/events/${event.id}/attendees.csv`)).status()).toBe(403);
    }
  });

  test("the door tool fits a phone", async ({ page }) => {
    await makeAttendee("member@ccss.test", { allergies: "gluten", food: true });
    await openCheckin(page);
    await search(page, "maja");
    await page.getByRole("button", { name: /maja Maja Medlem/ }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    const box = await page.getByRole("button", { name: "Checka in" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(48); // big tap target
  });
});
