import { expect, test, type Page } from "@playwright/test";
import { db, makeAttendee, resetRateLimits } from "./helpers";

test.beforeEach(resetRateLimits);

async function loginLeader(page: Page) {
  await page.context().clearCookies();
  await page.goto("/sv/login");
  await page.getByLabel("E-post").fill("leader@ccss.test");
  await page.getByLabel("Lösenord").fill("Password123!");
  await page.getByRole("button", { name: "Logga in" }).click();
  await expect(page).toHaveURL(/\/sv\/profile/);
}

async function setup() {
  const maja = await makeAttendee("member@ccss.test", { allergies: "nötter", food: true });
  const ture = await makeAttendee("minor@ccss.test");
  const leader = await db.user.findUniqueOrThrow({ where: { email: "leader@ccss.test" } });
  await db.ticket.update({ where: { id: maja.ticket.id }, data: { checkedInAt: new Date(), checkedInById: leader.id } });
  return { event: maja.event, maja, ture };
}

test.describe("event dashboard (Festivalledare)", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name === "mobile", "reporting screens are desktop tools"));

  test("statistics page shows tickets, seats, money and food", async ({ page }) => {
    const { event } = await setup();
    await loginLeader(page);
    await page.goto(`/sv/manage/events/${event.id}/stats`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Statistik");
    const active = await db.ticket.count({ where: { eventId: event.id, status: "ACTIVE" } });
    const checkedIn = await db.ticket.count({ where: { eventId: event.id, status: "ACTIVE", checkedInAt: { not: null } } });
    const overview = page.getByRole("region", { name: "Översikt" });
    await expect(overview.getByText("Sålda", { exact: true }).locator("..")).toContainText(String(active));
    await expect(overview.getByText("Incheckade", { exact: true }).locator("..")).toContainText(`${checkedIn}`);
    await expect(page.getByRole("heading", { name: "Biljetter per typ" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Standard med plats/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Platsbeläggning" })).toBeVisible();
    await expect(page.getByRole("img", { name: /Standard med plats: \d+ av 80/ })).toBeVisible(); // progress bar has a text alternative
    await expect(page.getByRole("heading", { name: "Pengar" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Frukostpaket/ })).toContainText("Standard: 1"); // Maja's breakfast
  });

  test("attendee list: search, filters, guardian for minors; CSV download is UTF-8 with BOM", async ({ page }) => {
    const { event } = await setup();
    await loginLeader(page);
    await page.goto(`/sv/manage/events/${event.id}/attendees`);
    await expect(page.getByRole("row", { name: /maja/ })).toContainText("nötter");
    await expect(page.getByRole("row", { name: /ture/ })).toContainText("Under 18");
    await expect(page.getByRole("row", { name: /ture/ })).toContainText("Greta Tonåring");

    await page.getByLabel("Ålder").selectOption("yes");
    await page.getByRole("button", { name: "Filtrera" }).click();
    await expect(page).toHaveURL(/minors=yes/);
    await expect(page.getByRole("row", { name: /ture/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /maja/ })).toHaveCount(0);

    await page.getByRole("link", { name: "Rensa" }).click();
    await expect(page).toHaveURL(/attendees$/);
    await expect(page.getByRole("row", { name: /maja/ })).toBeVisible(); // wait for the cleared list: the old form values must be gone
    await expect(page.getByRole("row", { name: /ture/ })).toBeVisible();
    await page.getByLabel("Incheckad", { exact: true }).selectOption("yes");
    await page.getByRole("button", { name: "Filtrera" }).click();
    await expect(page.getByRole("row", { name: /maja/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /ture/ })).toHaveCount(0);

    // export keeps the current filter
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Exportera CSV (Excel, svenska)" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^attendees-ccss-lan-hostlan-\d{8}\.csv$/);
    const bytes = await (await import("node:fs/promises")).readFile((await download.path())!);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8").slice(1);
    expect(text.split("\r\n")[0]).toBe("Namn;Nickname;E-post;Telefon;Födelsedatum;Ålder;Under 18;Målsman;Målsmans telefon;Allergier;Kostpreferenser;Biljett;Plats;Ordernummer;Incheckad;Incheckad av;Mat");
    expect(text).toContain("Maja Medlem;maja;member@ccss.test");
    expect(text).toContain("Frukostpaket (Standard)");
    expect(text).not.toContain("Ture Tonåring"); // filtered out
    expect(await db.auditLog.count({ where: { action: "attendees.export", eventId: event.id } })).toBeGreaterThanOrEqual(1);

    // unfiltered export (comma) has the guardian columns for Ture
    const all = await page.request.get(`/api/events/${event.id}/attendees.csv?delimiter=comma`);
    expect(all.headers()["content-type"]).toBe("text/csv; charset=utf-8");
    const body = await all.text();
    expect(body).toContain("Ture Tonåring,ture");
    expect(body).toContain("Greta Tonåring,+46 70 123 45 67");
  });

  test("email to attendees: needs confirmation, reaches exactly the paid ticket holders, is logged", async ({ page }) => {
    const { event } = await setup();
    await loginLeader(page);
    await page.goto(`/sv/manage/events/${event.id}/broadcast`);
    const holders = await db.ticket.findMany({ where: { eventId: event.id, status: "ACTIVE", user: { anonymizedAt: null } }, select: { userId: true }, distinct: ["userId"] });
    await expect(page.getByText(`(${holders.length} personer)`)).toBeVisible();

    const before = await db.emailOutbox.count({ where: { template: "broadcast" } });
    const subject = `Info ${Date.now()}`;
    await page.getByLabel("Ämne").fill(subject);
    await page.getByRole("textbox", { name: "Meddelande" }).fill("Dörrarna öppnar 17:00.\nGlöm inte headsetet!");
    await page.getByRole("button", { name: /^Skicka till/ }).click();
    await expect(page.getByText("Bekräfta att du vill skicka.")).toBeVisible();
    expect(await db.emailOutbox.count({ where: { template: "broadcast" } })).toBe(before); // nothing sent yet

    await page.getByLabel(/Jag förstår att meddelandet skickas/).check();
    await page.getByRole("button", { name: /^Skicka till/ }).click();
    await expect(page.getByText(`Skickat! ${holders.length} mejl är köade för utskick.`)).toBeVisible();
    expect(await db.emailOutbox.count({ where: { template: "broadcast" } })).toBe(before + holders.length);
    const b = await db.broadcast.findFirstOrThrow({ where: { eventId: event.id, subject } });
    expect(b.recipientCount).toBe(holders.length);

    await page.reload();
    await expect(page.getByText(subject)).toBeVisible(); // history
  });
});
