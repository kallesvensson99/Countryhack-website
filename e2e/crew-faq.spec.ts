import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetRateLimits } from "./helpers";

const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });
test.beforeEach(resetRateLimits);
test.afterAll(() => db.$disconnect());

const PASSWORD = "Password123!";

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

test.describe("FAQ editing (Festivalledare)", () => {
  test.afterEach(async () => {
    await db.faqItem.deleteMany(); // back to the built-in questions for the other specs
  });

  test("import the built-in questions, then edit, add, reorder and delete — the public page follows", async ({ page }) => {
    await db.faqItem.deleteMany();
    await login(page, "leader@ccss.test");
    await page.goto("/sv/manage/faq");
    await expect(page.getByRole("heading", { level: 1, name: "Redigera vanliga frågor" })).toBeVisible();
    await expect(page.getByText("Sidan visar just nu de inbyggda frågorna")).toBeVisible();

    await page.getByRole("button", { name: "Importera de inbyggda frågorna" }).click();
    await expect(page.getByRole("heading", { name: "Biljetter och betalning" })).toBeVisible();

    // edit an answer
    const row = page.locator("li", { hasText: "Hur köper jag en biljett?" }).first();
    await row.locator("summary").first().click();
    await row.getByLabel("Svar (svenska)").fill("Bara fråga crewet i entrén. (Redigerat)");
    await row.getByRole("button", { name: "Spara frågan" }).click();
    await expect(row.getByText("Frågan är sparad.")).toBeVisible();

    // add a new question to "På plats" with an English translation
    const add = page.getByRole("region", { name: "Lägg till en fråga" });
    await add.getByLabel("Avsnitt").selectOption({ label: "På plats" });
    await add.getByLabel("Fråga (svenska)").fill("Finns det parkering?");
    await add.getByLabel("Svar (svenska)").fill("Ja, utanför huset. Mejla {contact} om du behöver mer hjälp.");
    await add.locator("summary").click();
    await add.getByLabel("Fråga (engelska)").fill("Is there parking?");
    await add.getByLabel("Svar (engelska)").fill("Yes, outside the building.");
    await add.getByRole("button", { name: "Lägg till frågan" }).click();
    await expect(add.getByText("Frågan är sparad.")).toBeVisible();

    // move "Hur gammal måste jag vara?" above "Hur köper jag en biljett?"
    await page.getByRole("button", { name: "Flytta upp: Hur gammal måste jag vara?" }).click();
    await expect.poll(async () => (await db.faqItem.findFirstOrThrow({ where: { questionSv: "Hur gammal måste jag vara?" } })).sortOrder).toBe(0);

    await page.goto("/sv/faq");
    const questions = page.locator("#faq-tickets details summary");
    await expect(questions.first()).toContainText("Hur gammal måste jag vara?");
    await page.locator("details", { hasText: "Hur köper jag en biljett?" }).first().locator("summary").click();
    await expect(page.getByText("Bara fråga crewet i entrén. (Redigerat)")).toBeVisible();
    await page.locator("details", { hasText: "Finns det parkering?" }).locator("summary").click();
    await expect(page.getByText("Ja, utanför huset. Mejla info@ccss.test om du behöver mer hjälp.")).toBeVisible(); // {contact} filled in

    await page.goto("/en/faq");
    await expect(page.getByText("Is there parking?")).toBeVisible();
    await expect(page.getByText("Finns det parkering?")).toHaveCount(0);

    // delete the new one
    await page.goto("/sv/manage/faq");
    page.once("dialog", (d) => void d.accept());
    const mine = page.locator("li", { hasText: "Finns det parkering?" }).first();
    await mine.locator("summary").first().click();
    await mine.getByRole("button", { name: "Ta bort" }).click();
    await expect.poll(() => db.faqItem.count({ where: { questionSv: "Finns det parkering?" } })).toBe(0);
  });

  test("only Festivalledare can edit: members and Ansvarig get a 404", async ({ page }) => {
    await login(page, "ansvarig@ccss.test");
    await page.goto("/sv/manage/faq");
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Redigera frågor" })).toHaveCount(0);
    await logout(page);
    await login(page, "member@ccss.test");
    await page.goto("/sv/manage/faq");
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
  });
});

test.describe("crew jobs and applications", () => {
  const title = `E2E-uppdrag ${Date.now()}`;
  test.afterAll(async () => {
    await db.crewJob.deleteMany({ where: { title: { startsWith: "E2E-uppdrag" } } });
  });

  test("Ansvarig posts a job, a member applies, Ansvarig accepts, the member sees it", async ({ page }) => {
    // Ansvarig posts and sees only their own jobs
    await login(page, "ansvarig@ccss.test");
    await expect(page.getByRole("link", { name: "Hantera crew" })).toBeVisible();
    await page.goto("/sv/manage/crew");
    await expect(page.getByRole("heading", { level: 1, name: "Crew-jobb" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Incheckning och information" })).toHaveCount(0); // seeded, not posted by them
    const form = page.getByRole("region", { name: "Lägg upp ett uppdrag" });
    await form.getByRole("button", { name: "Lägg upp uppdraget" }).click(); // empty form
    await expect(form.getByText("Fältet är obligatoriskt.").first()).toBeVisible();
    await form.getByLabel("Titel (svenska)").fill(title);
    await form.getByLabel("Beskrivning (svenska)").fill("Hjälp till vid entrén.");
    await form.getByLabel("Antal personer").fill("3");
    await form.getByRole("button", { name: "Lägg upp uppdraget" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await logout(page);

    // a member finds it on the public page and applies
    await login(page, "member@ccss.test");
    await page.goto("/sv/crew");
    const card = page.locator("li", { hasText: title });
    await expect(card).toContainText("Vi söker 3 personer");
    await card.getByRole("link", { name: `Ansök till ${title}` }).click();
    await expect(page).toHaveURL(/\/sv\/crew\/apply\?job=/);
    await expect(page.getByLabel("Uppdrag")).toHaveValue(/.+/);
    await page.getByRole("button", { name: "Skicka ansökan" }).click(); // empty
    await expect(page.getByText("Fältet är obligatoriskt.").first()).toBeVisible();
    await page.getByLabel("Varför vill du vara med, och vad kan du?").fill("Jag är bra på att möta folk.");
    await page.getByLabel("När kan du?").fill("Hela helgen");
    await page.getByRole("button", { name: "Skicka ansökan" }).click();
    await expect(page.getByText("Tack! Din ansökan är skickad.")).toBeVisible();
    await page.goto("/sv/crew");
    await expect(page.locator("li", { hasText: title })).toContainText("Du har ansökt · Mottagen");
    await logout(page);

    // Ansvarig reviews and accepts
    await login(page, "ansvarig@ccss.test");
    await page.goto("/sv/manage/crew");
    const job = page.locator("li", { has: page.getByRole("heading", { name: title }) });
    await expect(job.getByText("Ansökningar (1)")).toBeVisible();
    await expect(job).toContainText("Maja Medlem");
    await expect(job).toContainText("Jag är bra på att möta folk.");
    await expect(job).toContainText("Hela helgen");
    await job.getByRole("button", { name: /Godkänn/ }).click();
    await expect(job.getByText("Statusen är sparad.")).toBeVisible();
    await logout(page);

    // the member sees the result and can withdraw
    await login(page, "member@ccss.test");
    await page.goto("/sv/crew/apply");
    const mine = page.locator("li", { hasText: title });
    await expect(mine).toContainText("Godkänd");
    page.once("dialog", (d) => void d.accept());
    await mine.getByRole("button", { name: "Ta tillbaka ansökan" }).click();
    await expect.poll(() => db.crewApplication.count({ where: { job: { title } } })).toBe(0);
  });

  test("Festivalledare see every job and may edit and close any of them", async ({ page }) => {
    const owner = await db.user.findUniqueOrThrow({ where: { email: "ansvarig@ccss.test" } });
    const t = `E2E-uppdrag leader ${Date.now()}`;
    await db.crewJob.create({ data: { title: t, description: "Test", during: true, createdById: owner.id } });
    await login(page, "leader@ccss.test");
    await expect(page.getByRole("link", { name: "Hantera crew" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Redigera frågor" })).toBeVisible();
    await page.goto("/sv/manage/crew");
    await expect(page.getByRole("heading", { name: "Incheckning och information" })).toBeVisible(); // seeded job
    const row = page.locator("li", { has: page.getByRole("heading", { name: t }) });
    await expect(row).toContainText("Upplagt av anders");
    await row.locator("summary").first().click();
    await row.getByLabel("Öppet för ansökningar").uncheck();
    await row.getByRole("button", { name: "Spara uppdraget" }).click();
    await expect(row.getByText("Uppdraget är sparat.")).toBeVisible();
    await expect.poll(async () => (await db.crewJob.findFirstOrThrow({ where: { title: t } })).isOpen).toBe(false);
    // a closed job is not listed publicly
    await page.goto("/sv/crew");
    await expect(page.getByRole("heading", { name: t })).toHaveCount(0);
  });

  test("members and visitors cannot manage crew jobs; visitors are asked to log in to apply", async ({ page }) => {
    await page.goto("/sv/crew/apply");
    await expect(page.getByText("Logga in eller skapa ett konto för att ansöka.")).toBeVisible();
    await page.goto("/sv/manage/crew");
    await expect(page).toHaveURL(/\/sv\/login/);
    await login(page, "member@ccss.test");
    await page.goto("/sv/manage/crew");
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Hantera crew" })).toHaveCount(0);
  });

  test("an unverified member is asked to confirm their email first", async ({ page }) => {
    await login(page, "unverified@ccss.test");
    await page.goto("/sv/crew/apply");
    await expect(page.getByText("Du behöver bekräfta din e-postadress innan du kan ansöka.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Skicka ansökan" })).toHaveCount(0);
  });
});

test.describe("the Ansvarig role", () => {
  test("an admin can grant and remove it", async ({ page }) => {
    await db.userTag.deleteMany({ where: { user: { email: "member@ccss.test" }, tag: "ANSVARIG" } });
    try {
      await login(page, "admin@ccss.test");
      await page.goto("/sv/admin/users?q=maja");
      await page.getByRole("button", { name: /Ge rollen Ansvarig/ }).click();
      await expect.poll(() => db.userTag.count({ where: { user: { email: "member@ccss.test" }, tag: "ANSVARIG" } })).toBe(1);
      await expect(page.getByRole("button", { name: /Ta bort rollen Ansvarig/ })).toBeVisible();
    } finally {
      await db.userTag.deleteMany({ where: { user: { email: "member@ccss.test" }, tag: "ANSVARIG" } });
    }
  });
});
