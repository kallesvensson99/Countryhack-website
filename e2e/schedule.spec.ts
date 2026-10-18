import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetRateLimits } from "./helpers";

const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });
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

async function logout(page: Page) {
  await page.getByRole("button", { name: "Logga ut" }).click();
  await expect(page.getByRole("link", { name: "Logga in" }).first()).toBeVisible();
}

test.describe("event schedule", () => {
  test.afterEach(async () => {
    const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
    await db.scheduleItem.deleteMany({ where: { eventId: event.id } });
    await db.scheduleCategory.deleteMany({ where: { eventId: event.id } });
  });

  test("Festivalledare build a colour-coded block schedule; visitors see it, in English too", async ({ page, browser }) => {
    const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
    await db.scheduleItem.deleteMany({ where: { eventId: event.id } });
    await db.scheduleCategory.deleteMany({ where: { eventId: event.id } });

    await login(page, "leader@ccss.test");
    await page.goto(`/sv/manage/events/${event.id}`);
    await page.getByRole("link", { name: "Schema" }).click();
    await expect(page).toHaveURL(new RegExp(`/sv/manage/events/${event.id}/schedule$`));
    await expect(page.getByRole("heading", { level: 1, name: "Schema" })).toBeVisible();

    // categories with colours
    const newCat = page.getByRole("group", { name: "Lägg till en kategori" });
    const addCategory = async (name: string, colour: string, n: number, nameEn?: string) => {
      await newCat.getByLabel("Namn", { exact: true }).fill(name);
      if (nameEn) await newCat.getByLabel("Namn (engelska)").fill(nameEn);
      await newCat.getByText(colour, { exact: true }).click();
      await newCat.getByRole("button", { name: "Lägg till kategorin" }).click();
      // the form resets when the action ends, in the same render that adds the category to the list below it: wait for that
      await expect(page.locator("li", { hasText: name }).first()).toBeVisible();
      await expect.poll(() => db.scheduleCategory.count({ where: { eventId: event.id } })).toBe(n);
    };
    await newCat.getByRole("button", { name: "Lägg till kategorin" }).click(); // empty
    await expect(newCat.getByText("Fältet är obligatoriskt.").first()).toBeVisible();
    await addCategory("Turnering", "Gul", 1, "Tournament");
    await addCategory("Mat", "Röd", 2);
    const cats = await db.scheduleCategory.findMany({ where: { eventId: event.id } });
    expect(cats.find((c) => c.name === "Turnering")!.color).toBe("hay");
    expect(cats.find((c) => c.name === "Mat")!.color).toBe("barn");
    await newCat.getByLabel("Namn", { exact: true }).fill("Turnering");
    await newCat.getByRole("button", { name: "Lägg till kategorin" }).click();
    await expect(newCat.getByText("Det finns redan en kategori med det namnet.")).toBeVisible();

    // blocks: two overlap on Friday, one on Saturday
    const newItem = page.getByRole("group", { name: "Lägg till ett block" });
    const addItem = async (title: string, start: string, end: string, category: string | null, n: number, extra: { location?: string; titleEn?: string } = {}) => {
      await newItem.getByLabel("Rubrik", { exact: true }).fill(title);
      await newItem.getByLabel("Start").fill(start);
      await newItem.getByLabel("Slut").fill(end);
      if (category) await newItem.getByLabel("Kategori").selectOption({ label: category });
      if (extra.location) await newItem.getByLabel("Plats").fill(extra.location);
      if (extra.titleEn) {
        await newItem.locator("summary").click();
        await newItem.getByLabel("Rubrik (engelska)").fill(extra.titleEn);
      }
      await newItem.getByRole("button", { name: "Lägg till blocket" }).click();
      await expect(page.locator("li", { hasText: title }).first()).toBeVisible(); // the list below the form updates together with the form reset
      await expect.poll(() => db.scheduleItem.count({ where: { eventId: event.id } })).toBe(n);
    };
    await newItem.getByLabel("Rubrik", { exact: true }).fill("Fel tid");
    await newItem.getByLabel("Start").fill("2026-12-18T20:00");
    await newItem.getByLabel("Slut").fill("2026-12-18T19:00");
    await newItem.getByRole("button", { name: "Lägg till blocket" }).click();
    await expect(newItem.getByText("Sluttiden måste vara efter starttiden.")).toBeVisible();
    expect(await db.scheduleItem.count({ where: { eventId: event.id } })).toBe(0);

    await addItem("Counter-Strike-turnering", "2026-12-18T18:00", "2026-12-18T21:00", "Turnering", 1, { location: "Stora salen", titleEn: "CS tournament" });
    await addItem("Pizzakväll", "2026-12-18T19:00", "2026-12-18T20:00", "Mat", 2, { location: "Köket" });
    await addItem("Frukost", "2026-12-19T08:00", "2026-12-19T09:30", "Mat", 3);

    // the preview on the management page: blocks in their category colours, with the category as text
    await page.reload();
    const preview = page.getByRole("region", { name: "Så ser schemat ut" });
    const cs = preview.getByRole("listitem").filter({ hasText: "Counter-Strike-turnering" }).first();
    const pizza = preview.getByRole("listitem").filter({ hasText: "Pizzakväll" }).first();
    await expect(cs).toContainText("18:00–21:00");
    await expect(cs).toContainText("Turnering");
    await expect(cs).toContainText("Stora salen");
    await expect(cs).toHaveCSS("background-color", "rgb(233, 183, 58)"); // gul
    await expect(pizza).toHaveCSS("background-color", "rgb(184, 58, 36)"); // röd
    await expect(pizza).toHaveCSS("color", "rgb(255, 255, 255)"); // readable text on red
    // the two overlapping blocks share the width instead of covering each other
    const a = (await cs.boundingBox())!;
    const b = (await pizza.boundingBox())!;
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1);
    expect(b.y).toBeGreaterThan(a.y); // pizza starts an hour later
    await logout(page);

    // a visitor sees it from the event page, with a legend, per-day headings and a list alternative
    const visitor = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
    await visitor.goto(`/sv/events/${SLUG}`);
    await visitor.getByRole("link", { name: "Visa schema" }).click();
    await expect(visitor).toHaveURL(new RegExp(`/sv/events/${SLUG}/schema$`));
    await expect(visitor.getByRole("heading", { level: 1, name: "Schema" })).toBeVisible();
    await expect(visitor.getByRole("heading", { level: 2, name: /fredag 18 december/i })).toBeVisible();
    await expect(visitor.getByRole("heading", { level: 2, name: /lördag 19 december/i })).toBeVisible();
    const legend = visitor.getByRole("region", { name: "Kategorier" });
    await expect(legend).toContainText("Turnering");
    await expect(legend).toContainText("Mat");
    await expect(visitor.getByRole("listitem").filter({ hasText: "Frukost" }).first()).toBeVisible();
    await visitor.getByText("Visa som lista").first().click();
    await expect(visitor.getByRole("link", { name: "Redigera schemat" })).toHaveCount(0);
    await visitor.goto("/sv/events");
    await expect(visitor.getByRole("link", { name: "Schema" }).first()).toHaveAttribute("href", `/sv/events/${SLUG}/schema`);
    await visitor.goto(`/en/events/${SLUG}/schema`);
    await expect(visitor.getByRole("heading", { level: 1, name: "Schedule" })).toBeVisible();
    await expect(visitor.getByRole("listitem").filter({ hasText: "CS tournament" }).first()).toBeVisible(); // English title
    await expect(visitor.getByRole("listitem").filter({ hasText: "Pizzakväll" }).first()).toBeVisible(); // Swedish fallback
    await expect(visitor.getByRole("region", { name: "Categories" })).toContainText("Tournament");
    await visitor.context().close();

    // edit a block, delete a category (its blocks stay as "Övrigt") and a block
    await login(page, "leader@ccss.test");
    await page.goto(`/sv/manage/events/${event.id}/schedule`);
    const row = page.locator("li", { hasText: "Frukost" }).filter({ has: page.locator("summary", { hasText: "Redigera" }) }).first();
    await row.locator("summary").first().click();
    await row.getByLabel("Slut").fill("2026-12-19T10:00");
    await row.getByRole("button", { name: "Spara blocket" }).click();
    await expect.poll(async () => (await db.scheduleItem.findFirstOrThrow({ where: { title: "Frukost" } })).endsAt.toISOString()).toBe("2026-12-19T09:00:00.000Z");

    page.on("dialog", (d) => void d.accept());
    const catRow = page.locator("li", { hasText: "Mat" }).filter({ has: page.locator("summary", { hasText: "Redigera" }) }).first();
    await catRow.locator("summary").first().click();
    await catRow.getByRole("button", { name: "Ta bort kategorin" }).click();
    await expect.poll(() => db.scheduleCategory.count({ where: { eventId: event.id, name: "Mat" } })).toBe(0);
    expect(await db.scheduleItem.count({ where: { eventId: event.id } })).toBe(3); // blocks stay
    expect((await db.scheduleItem.findFirstOrThrow({ where: { title: "Pizzakväll" } })).categoryId).toBeNull();

    await page.reload();
    const itemRow = page.locator("li", { hasText: "Pizzakväll" }).filter({ has: page.locator("summary", { hasText: "Redigera" }) }).first();
    await itemRow.locator("summary").first().click();
    await itemRow.getByRole("button", { name: "Ta bort blocket" }).click();
    await expect.poll(() => db.scheduleItem.count({ where: { eventId: event.id, title: "Pizzakväll" } })).toBe(0);
  });

  test("a draft event's schedule is not public", async ({ page, browser }) => {
    const leader = await db.user.findUniqueOrThrow({ where: { email: "leader@ccss.test" } });
    const stamp = Date.now();
    const draft = await db.event.create({
      data: {
        slug: `e2e-schema-utkast-${stamp}`,
        name: `E2E-Schema ${stamp}`,
        description: "x",
        venueName: "Hallen",
        address: "Gatan 1",
        startsAt: new Date("2027-07-02T15:00:00Z"),
        endsAt: new Date("2027-07-03T15:00:00Z"),
        registrationOpensAt: new Date("2027-01-01T00:00:00Z"),
        registrationClosesAt: new Date("2027-06-30T00:00:00Z"),
        status: "DRAFT",
        createdById: leader.id,
      },
    });
    try {
      await db.scheduleItem.create({ data: { eventId: draft.id, title: "Hemligt", startsAt: draft.startsAt, endsAt: new Date(draft.startsAt.getTime() + 3600_000) } });
      const visitor = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
      expect((await visitor.goto(`/sv/events/${draft.slug}/schema`))?.status()).toBe(404);
      await visitor.context().close();
      await login(page, "leader@ccss.test");
      await page.goto(`/sv/events/${draft.slug}/schema`);
      await expect(page.getByRole("listitem").filter({ hasText: "Hemligt" }).first()).toBeVisible();
    } finally {
      await db.event.delete({ where: { id: draft.id } });
    }
  });

  test("members and Ansvarig cannot edit the schedule", async ({ page }) => {
    const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
    for (const email of ["member@ccss.test", "ansvarig@ccss.test"]) {
      await login(page, email);
      await page.goto(`/sv/manage/events/${event.id}/schedule`);
      await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
      await logout(page);
    }
  });
});

test.describe("Admin holds every right", () => {
  test("an admin without the other tags manages events, crew, FAQ, news, sponsors, the association page and the schedule", async ({ page }) => {
    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@ccss.test" }, include: { tags: true } });
    expect(admin.tags.map((t) => t.tag)).toEqual(["ADMIN"]); // really only the admin tag
    const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });

    await login(page, "admin@ccss.test");
    const nav = page.getByRole("navigation", { name: "Huvudnavigering" });
    for (const name of ["Hantera event", "Hantera crew", "Redigera frågor", "Admin"]) await expect(nav.getByRole("link", { name })).toBeVisible();

    const pages: [string, string][] = [
      ["/sv/manage/events", "Hantera event"],
      [`/sv/manage/events/${event.id}/schedule`, "Schema"],
      [`/sv/manage/events/${event.id}/tickets`, "Biljettyper"],
      [`/sv/manage/events/${event.id}/attendees`, "Deltagare"],
      ["/sv/manage/crew", "Crew-jobb"],
      ["/sv/manage/faq", "Redigera vanliga frågor"],
      ["/sv/manage/news", "Nyheter"],
      ["/sv/manage/sponsors", "Sponsorer"],
      ["/sv/manage/association", "Föreningssidan"],
      ["/sv/admin/users", "Användare"],
    ];
    for (const [url, heading] of pages) {
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1 }).first(), url).toContainText(heading);
    }
    // and the check-in tool, which used to be Festivalledare only
    expect((await page.goto(`/sv/manage/events/${event.id}/checkin`))?.status()).toBe(200);
    await expect(page.getByText("Sidan hittades inte.")).toHaveCount(0);
  });
});
