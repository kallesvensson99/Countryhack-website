import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetRateLimits } from "./helpers";

const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });
test.beforeEach(resetRateLimits);
test.afterAll(() => db.$disconnect());

const PASSWORD = "Password123!";
// a real 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function login(page: Page, email: string) {
  await page.goto("/sv/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Lösenord").fill(PASSWORD);
  await page.getByRole("button", { name: "Logga in" }).click();
  await expect(page).toHaveURL(/\/sv\/profile/);
}

test.describe("events page", () => {
  test("shows the details of each event without opening it: dates, venue, age, free seats, description and tickets", async ({ page }) => {
    await page.goto("/sv/events");
    const card = page.locator("li", { has: page.getByRole("link", { name: "Countryhack" }) }).first();
    await expect(card.getByRole("heading", { name: "Countryhack" })).toBeVisible();
    await expect(card).toContainText("Folkets Hus");
    await expect(card).toContainText("Storgatan");
    await expect(card).toContainText("14 år");
    await expect(card).toContainText("av 60 lediga");
    await expect(card).toContainText("Tre dagar med spel, mat och gemenskap");
    await expect(card.getByRole("heading", { name: "Biljetter" })).toBeVisible();
    await expect(card).toContainText("Standard med plats");
    await expect(card).toContainText("150 kr");
    await expect(card).toContainText("Inkluderar plats");
    await expect(card).toContainText("Till salu");
    await expect(card).not.toContainText("Crew"); // hidden ticket types stay hidden
    await expect(card.getByRole("link", { name: /Köp biljett|Läs mer/ })).toHaveAttribute("href", /\/sv\/events\/ccss-lan-hostlan$/);
  });
});

test.describe("sponsors", () => {
  test.afterEach(async () => {
    await db.sponsor.deleteMany();
  });

  test("Festivalledare add sponsors in three tiers; the landing page shows them grouped, linked and in order", async ({ page }) => {
    await db.sponsor.deleteMany();
    await login(page, "leader@ccss.test");
    await page.goto("/sv/manage/sponsors");
    await expect(page.getByRole("heading", { level: 1, name: "Sponsorer" })).toBeVisible();

    const add = page.getByRole("region", { name: "Lägg till en sponsor" });
    const create = async (name: string, tier: string, extra: { url?: string; file?: { name: string; mimeType: string; buffer: Buffer } } = {}) => {
      await add.getByLabel("Namn").fill(name);
      await add.getByLabel("Nivå").selectOption({ label: tier });
      if (extra.url !== undefined) await add.getByLabel("Webbadress").fill(extra.url);
      await add.getByLabel("Logotyp").setInputFiles(extra.file ?? { name: "logo.png", mimeType: "image/png", buffer: PNG });
      await add.getByRole("button", { name: "Lägg till sponsorn" }).click();
    };
    // the form resets when an action finishes, so wait for each save before filling in the next sponsor
    const created = async (n: number) => expect.poll(() => db.sponsor.count()).toBe(n);

    // validation: a logo is required by the browser form, a bad link and a non-image are refused by the server
    await create("Fel länk", "Sponsor", { url: "javascript:alert(1)" });
    await expect(add.getByText("Skriv en webbadress som börjar med http:// eller https://.")).toBeVisible();
    await create("Ingen bild", "Sponsor", { url: "", file: { name: "x.png", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)>") } });
    await expect(add.getByText(/bild|image/i).first()).toBeVisible();
    expect(await db.sponsor.count()).toBe(0);

    await create("Småfirman", "Sponsor");
    await created(1);
    await expect(page.getByRole("heading", { name: "Småfirman" }).or(page.getByText("Småfirman").first())).toBeVisible();
    await create("Mellanbolaget", "Stor sponsor");
    await created(2);
    await create("Kabelkungen", "Huvudsponsor", { url: "https://kabelkungen.example/" });
    await created(3);

    // hidden sponsors stay off the public page
    await db.sponsor.create({ data: { name: "Dold sponsor", tier: "MAIN", logoPath: (await db.sponsor.findFirstOrThrow()).logoPath, isActive: false } });

    await page.goto("/sv");
    const region = page.getByRole("region", { name: "Våra sponsorer" });
    await expect(page.getByRole("contentinfo").getByRole("region", { name: "Våra sponsorer" })).toBeVisible(); // it lives in the footer
    await expect(region).toBeVisible();
    const tiers = await region.getByRole("heading", { level: 3 }).allTextContents();
    expect(tiers).toEqual(["Huvudsponsor", "Stor sponsor", "Sponsor"]);
    await expect(region.getByRole("img", { name: "Kabelkungen" })).toBeVisible();
    await expect(region.getByRole("img", { name: "Mellanbolaget" })).toBeVisible();
    await expect(region.getByRole("img", { name: "Småfirman" })).toBeVisible();
    await expect(region.getByRole("img", { name: "Dold sponsor" })).toHaveCount(0);
    await expect(region.getByRole("link", { name: "Kabelkungen" })).toHaveAttribute("href", "https://kabelkungen.example/");
    await expect(region.getByRole("link", { name: "Kabelkungen" })).toHaveAttribute("rel", /noopener/);
    await expect(region.getByRole("link", { name: "Småfirman" })).toHaveCount(0); // no link given
    // the footer is on every page, so the sponsors are always visible
    for (const path of ["/sv/faq", "/sv/events", "/en/crew"]) {
      await page.goto(path);
      await expect(page.getByRole("contentinfo").getByRole("img", { name: "Kabelkungen" })).toBeVisible();
    }
    await page.goto("/sv");
    // the logo file is really served
    const src = (await region.getByRole("img", { name: "Kabelkungen" }).getAttribute("src"))!;
    expect(src).toMatch(/^\/uploads\/sponsors\/[a-f0-9]{32}\.png$/);
    const res = await page.request.get(src);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
  });

  test("edit and delete; the page has no sponsor section when there are none", async ({ page }) => {
    await db.sponsor.deleteMany();
    await login(page, "leader@ccss.test");
    await page.goto("/sv");
    await expect(page.getByRole("region", { name: "Våra sponsorer" })).toHaveCount(0);

    await page.goto("/sv/manage/sponsors");
    await expect(page.getByText("Inga sponsorer än.")).toBeVisible();
    const add = page.getByRole("region", { name: "Lägg till en sponsor" });
    await add.getByLabel("Namn").fill("Redigerbar");
    await add.getByLabel("Logotyp").setInputFiles({ name: "l.png", mimeType: "image/png", buffer: PNG });
    await add.getByRole("button", { name: "Lägg till sponsorn" }).click();
    const row = page.locator("li", { hasText: "Redigerbar" }).first();
    await expect(row).toBeVisible();

    await row.locator("summary").first().click();
    await row.getByLabel("Namn").fill("Omdöpt");
    await row.getByLabel("Nivå").selectOption({ label: "Huvudsponsor" });
    await row.getByRole("button", { name: "Spara sponsorn" }).click();
    await expect.poll(async () => (await db.sponsor.findFirstOrThrow()).name).toBe("Omdöpt");
    expect((await db.sponsor.findFirstOrThrow()).tier).toBe("MAIN");

    await page.reload();
    page.once("dialog", (d) => void d.accept());
    const row2 = page.locator("li", { hasText: "Omdöpt" }).first();
    await row2.locator("summary").first().click();
    await row2.getByRole("button", { name: "Ta bort sponsorn" }).click();
    await expect.poll(() => db.sponsor.count()).toBe(0);
  });

  test("members and Ansvarig cannot manage sponsors", async ({ page }) => {
    await login(page, "ansvarig@ccss.test");
    await page.goto("/sv/manage/sponsors");
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
    await page.getByRole("button", { name: "Logga ut" }).click();
    await login(page, "member@ccss.test");
    await page.goto("/sv/manage/sponsors");
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
  });
});
