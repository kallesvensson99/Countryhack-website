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

test.describe("news", () => {
  test.afterEach(async () => {
    await db.newsPost.deleteMany({ where: { title: { startsWith: "E2E-" } } });
  });

  test("the seeded news post is on the landing page and under the News tab", async ({ page }) => {
    await page.goto("/sv");
    const section = page.getByRole("region", { name: "Senaste nytt" });
    await expect(section.getByRole("heading", { name: "Välkommen till Countryhack" })).toBeVisible();
    await section.getByRole("link", { name: "Alla nyheter" }).click();
    await expect(page).toHaveURL(/\/sv\/nyheter$/);
    await expect(page.getByRole("heading", { level: 1, name: "Nyheter" })).toBeVisible();
    await page.getByRole("link", { name: "Välkommen till Countryhack" }).first().click();
    await expect(page).toHaveURL(/\/sv\/nyheter\/valkommen-till-countryhack$/);
    await expect(page.getByRole("heading", { level: 1, name: "Välkommen till Countryhack" })).toBeVisible();
    await expect(page.getByText("Följ nyheterna här för information inför eventet.")).toBeVisible();
    await page.goto("/en/nyheter/valkommen-till-countryhack");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome to Countryhack" })).toBeVisible();
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "News" }).click();
    await expect(page).toHaveURL(/\/en\/nyheter$/);
  });

  test("Festivalledare write, schedule and publish; drafts stay hidden until published", async ({ page, browser }) => {
    const stamp = Date.now();
    const live = `E2E-Live ${stamp}`;
    const draft = `E2E-Utkast ${stamp}`;
    const later = `E2E-Planerad ${stamp}`;

    await login(page, "leader@ccss.test");
    await expect(page.getByRole("navigation", { name: "Huvudnavigering" }).getByRole("link", { name: "Nyheter" })).toBeVisible();
    await page.goto("/sv/nyheter");
    await page.getByRole("link", { name: "Hantera nyheter" }).click();
    await expect(page).toHaveURL(/\/sv\/manage\/news$/);

    const form = page.getByRole("region", { name: "Skriv en nyhet" });
    await form.getByRole("button", { name: "Spara nyheten" }).click(); // empty
    await expect(form.getByText("Fältet är obligatoriskt.").first()).toBeVisible();

    const write = async (title: string, body: string, opts: { published: boolean; at?: string; image?: boolean; en?: [string, string] }, n: number) => {
      await form.getByLabel("Rubrik (svenska)").fill(title);
      await form.getByLabel("Text (svenska)").fill(body);
      if (opts.en) {
        await form.locator("summary").first().click();
        await form.getByLabel("Rubrik (engelska)").fill(opts.en[0]);
        await form.getByLabel("Text (engelska)").fill(opts.en[1]);
      }
      if (opts.image) await form.getByLabel("Bild").setInputFiles({ name: "b.png", mimeType: "image/png", buffer: PNG });
      const box = form.getByLabel("Publicerad");
      if (opts.published) await box.check();
      else await box.uncheck();
      if (opts.at) await form.getByLabel("Publiceringstid").fill(opts.at);
      await form.getByRole("button", { name: "Spara nyheten" }).click();
      // the form resets when the action finishes: wait before the next one
      await expect.poll(() => db.newsPost.count({ where: { title: { startsWith: "E2E-" } } })).toBe(n);
    };

    await write(live, "Första stycket i den publicerade nyheten.\n\nAndra stycket.", { published: true, image: true, en: [`E2E-Live EN ${stamp}`, "English first paragraph."] }, 1);
    await write(draft, "Det här är ett utkast.", { published: false }, 2);
    await write(later, "Den här kommer senare.", { published: true, at: "2099-01-01T10:00" }, 3);

    const rows = await db.newsPost.findMany({ where: { title: { startsWith: "E2E-" } } });
    const slug = (t: string) => rows.find((r) => r.title === t)!.slug;
    expect(rows.find((r) => r.title === live)!.imagePath).toMatch(/^\/uploads\/news\/[a-f0-9]{32}\.png$/);

    // status labels on the management page
    await page.reload();
    await expect(page.locator("li", { hasText: live }).first()).toContainText("Publicerad");
    await expect(page.locator("li", { hasText: draft }).first()).toContainText("Utkast");
    await expect(page.locator("li", { hasText: later }).first()).toContainText("Schemalagd");

    // a leader can open the draft and the scheduled post, with a note
    await page.goto(`/sv/nyheter/${slug(draft)}`);
    await expect(page.getByText("Det här är ett utkast. Bara festivalledare ser det.")).toBeVisible();
    await page.goto(`/sv/nyheter/${slug(later)}`);
    await expect(page.getByText(/Den här nyheten publiceras/)).toBeVisible();

    // a visitor sees only the live post, in both lists, with its picture; the others are 404
    const visitor = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
    await visitor.goto("/sv");
    const home = visitor.getByRole("region", { name: "Senaste nytt" });
    await expect(home.getByRole("heading", { name: live })).toBeVisible();
    await expect(home.getByText("Första stycket i den publicerade nyheten.")).toBeVisible();
    await expect(home.getByText("Andra stycket.")).toHaveCount(0); // only the first paragraph is the summary
    await expect(visitor.getByText(draft)).toHaveCount(0);
    await expect(visitor.getByText(later)).toHaveCount(0);
    await visitor.goto("/sv/nyheter");
    await expect(visitor.getByRole("heading", { name: live })).toBeVisible();
    await expect(visitor.getByText(draft)).toHaveCount(0);
    await expect(visitor.getByRole("link", { name: "Hantera nyheter" })).toHaveCount(0);
    await visitor.goto(`/sv/nyheter/${slug(live)}`);
    await expect(visitor.getByText("Andra stycket.")).toBeVisible();
    const imgSrc = (await visitor.locator("article img").first().getAttribute("src"))!;
    expect((await visitor.request.get(imgSrc)).status()).toBe(200);
    for (const t of [draft, later]) {
      const res = await visitor.goto(`/sv/nyheter/${slug(t)}`);
      expect(res?.status()).toBe(404);
    }
    await visitor.goto(`/en/nyheter/${slug(live)}`);
    await expect(visitor.getByRole("heading", { level: 1, name: `E2E-Live EN ${stamp}` })).toBeVisible();
    await visitor.context().close();

    // publish the draft: it appears for everyone
    await page.goto("/sv/manage/news");
    const row = page.locator("li", { has: page.getByRole("link", { name: draft }) }).first();
    await row.locator("summary").first().click();
    await row.getByLabel("Publicerad").check();
    await row.getByRole("button", { name: "Spara nyheten" }).click();
    await expect.poll(async () => !!(await db.newsPost.findFirstOrThrow({ where: { title: draft } })).publishedAt).toBe(true);
    await page.goto("/sv/nyheter");
    await expect(page.getByRole("heading", { name: draft })).toBeVisible();

    // delete one
    await page.goto("/sv/manage/news");
    page.once("dialog", (d) => void d.accept());
    const del = page.locator("li", { has: page.getByRole("link", { name: later }) }).first();
    await del.locator("summary").first().click();
    await del.getByRole("button", { name: "Ta bort nyheten" }).click();
    await expect.poll(() => db.newsPost.count({ where: { title: later } })).toBe(0);
  });

  test("members and Ansvarig cannot manage news", async ({ page }) => {
    for (const email of ["member@ccss.test", "ansvarig@ccss.test"]) {
      await login(page, email);
      await page.goto("/sv/manage/news");
      await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
      await page.getByRole("button", { name: "Logga ut" }).click();
      await expect(page.getByRole("link", { name: "Logga in" }).first()).toBeVisible();
    }
  });
});
