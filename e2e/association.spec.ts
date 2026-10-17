import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetRateLimits } from "./helpers";

const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });
test.beforeEach(resetRateLimits);
test.afterAll(() => db.$disconnect());

const PASSWORD = "Password123!";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("e2e protokoll ".repeat(20))]);

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

test.describe("association page", () => {
  const TAG = `E2E-${Date.now()}`;
  test.afterEach(async () => {
    await db.associationDocument.deleteMany({ where: { title: { startsWith: "E2E-" } } });
    await db.boardMember.deleteMany({ where: { name: { startsWith: "E2E-" } } });
  });

  test("the page shows the editable intro and is reachable from the header", async ({ page }) => {
    await page.goto("/sv");
    await page.getByRole("navigation", { name: "Huvudnavigering" }).getByRole("link", { name: "Föreningen" }).click();
    await expect(page).toHaveURL(/\/sv\/forening$/);
    await expect(page.getByRole("heading", { level: 1, name: "Cable connectors spelsällskap (CCSS)" })).toBeVisible();
    await expect(page.getByText("ideell förening för människor som gillar att spela tillsammans")).toBeVisible();
    await page.goto("/en/forening");
    await expect(page.getByText("non-profit association for people who like to play together")).toBeVisible();
    await expect(page.getByRole("link", { name: "Redigera sidan" })).toHaveCount(0);
  });

  test("Festivalledare edit the intro, add board members and upload documents; visibility is enforced", async ({ page, browser }) => {
    const org = await db.orgSettings.findFirstOrThrow();
    const original = { sv: org.aboutIntroSv, en: org.aboutIntroEn };
    try {
      await login(page, "leader@ccss.test");
      await page.goto("/sv/forening");
      await page.getByRole("link", { name: "Redigera sidan" }).click();
      await expect(page).toHaveURL(/\/sv\/manage\/association$/);
      await expect(page.getByRole("heading", { level: 1, name: "Föreningssidan" })).toBeVisible();

      // intro (Swedish only: English falls back)
      const introForm = page.getByRole("region", { name: "Inledning" });
      await introForm.getByLabel("Inledning (svenska)").fill(`Välkommen ${TAG}.\nRad två.`);
      await introForm.locator("summary").click();
      await introForm.getByLabel("Inledning (engelska)").fill("");
      await introForm.getByRole("button", { name: "Spara inledningen" }).click();
      await expect(introForm.getByText("Inledningen är sparad.")).toBeVisible();

      // board member
      const newMember = page.getByRole("group", { name: "Lägg till en styrelseledamot" });
      await newMember.getByLabel("Namn").fill(`E2E-Eva ${TAG}`);
      await newMember.getByLabel("Roll", { exact: true }).fill("Ordförande");
      await newMember.getByLabel("E-post").fill("eva@example.se");
      await newMember.getByRole("button", { name: "Lägg till ledamoten" }).click();
      await expect(page.getByText(`E2E-Eva ${TAG}`).first()).toBeVisible();
      await expect.poll(() => db.boardMember.count({ where: { name: { startsWith: "E2E-" } } })).toBe(1);

      // documents in all three visibilities
      const up = page.getByRole("group", { name: "Ladda upp ett dokument" });
      const upload = async (title: string, visibility: string, n: number) => {
        await up.getByLabel("Titel").fill(title);
        await up.getByLabel("Typ").selectOption({ label: "Mötesprotokoll" });
        await up.getByLabel("Datum").fill("2026-09-12");
        await up.getByLabel("Vem får se dokumentet?").selectOption({ label: visibility });
        await up.getByLabel("Fil").setInputFiles({ name: `${title}.pdf`, mimeType: "application/pdf", buffer: PDF });
        await up.getByRole("button", { name: "Ladda upp dokumentet" }).click();
        // the form resets when the action finishes: wait before the next one
        await expect.poll(() => db.associationDocument.count({ where: { title: { startsWith: "E2E-" } } })).toBe(n);
      };
      // a file that is not a document is refused
      await up.getByLabel("Titel").fill("E2E-Fel fil");
      await up.getByLabel("Fil").setInputFiles({ name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html>not a pdf</html>") });
      await up.getByRole("button", { name: "Ladda upp dokumentet" }).click();
      await expect(up.getByText("Filen måste vara en PDF")).toBeVisible();
      expect(await db.associationDocument.count({ where: { title: "E2E-Fel fil" } })).toBe(0);

      await upload("E2E-Offentligt", "Alla", 1);
      await upload("E2E-Inloggade", "Inloggade", 2);
      await upload("E2E-Ledare", "Endast festivalledare", 3);

      const docs = await db.associationDocument.findMany({ where: { title: { startsWith: "E2E-" } } });
      const id = (t: string) => docs.find((d) => d.title === t)!.id;

      // the leader can download all three; the response is an attachment
      for (const t of ["E2E-Offentligt", "E2E-Inloggade", "E2E-Ledare"]) expect((await page.request.get(`/api/documents/${id(t)}`)).status()).toBe(200);
      const res = await page.request.get(`/api/documents/${id("E2E-Offentligt")}`);
      expect(res.headers()["content-type"]).toBe("application/pdf");
      expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="E2E-Offentligt\.pdf"/);
      expect(res.headers()["x-content-type-options"]).toBe("nosniff");
      expect((await res.body()).equals(PDF)).toBe(true);
      // the stored file is not reachable through the public uploads route
      const key = docs[0]!.storageKey;
      expect((await page.request.get(`/uploads/${key}`)).status()).toBe(404);
      await logout(page);

      // a visitor: the public one only, a hint about the rest, and no way to fetch the others
      const visitor = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
      await visitor.goto("/sv/forening");
      await expect(visitor.getByText(`Välkommen ${TAG}.`)).toBeVisible();
      await expect(visitor.getByText(`E2E-Eva ${TAG}`)).toBeVisible();
      await expect(visitor.getByRole("link", { name: "eva@example.se" })).toHaveAttribute("href", "mailto:eva@example.se");
      await expect(visitor.getByRole("link", { name: "E2E-Offentligt" })).toBeVisible();
      await expect(visitor.getByText("E2E-Inloggade")).toHaveCount(0);
      await expect(visitor.getByText("E2E-Ledare")).toHaveCount(0);
      await expect(visitor.getByText("Fler dokument finns för inloggade användare.")).toBeVisible();
      expect((await visitor.request.get(`/api/documents/${id("E2E-Offentligt")}`)).status()).toBe(200);
      expect((await visitor.request.get(`/api/documents/${id("E2E-Inloggade")}`)).status()).toBe(404);
      expect((await visitor.request.get(`/api/documents/${id("E2E-Ledare")}`)).status()).toBe(404);
      await visitor.goto("/en/forening");
      await expect(visitor.getByText(`Välkommen ${TAG}.`)).toBeVisible(); // English intro empty: Swedish fallback
      await visitor.context().close();

      // a member: public + logged-in, not the staff-only one
      await login(page, "member@ccss.test");
      await page.goto("/sv/forening");
      await expect(page.getByRole("link", { name: "E2E-Inloggade" })).toBeVisible();
      await expect(page.getByText("E2E-Ledare")).toHaveCount(0);
      expect((await page.request.get(`/api/documents/${id("E2E-Inloggade")}`)).status()).toBe(200);
      expect((await page.request.get(`/api/documents/${id("E2E-Ledare")}`)).status()).toBe(404);
      await page.goto("/sv/manage/association");
      await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
      await logout(page);

      // edit a document's visibility, then delete one (the file goes with it)
      await login(page, "leader@ccss.test");
      await page.goto("/sv/manage/association");
      const row = page.locator("li", { hasText: "E2E-Ledare" }).first();
      await row.locator("summary").first().click();
      await row.getByLabel("Vem får se dokumentet?").selectOption({ label: "Alla" });
      await row.getByRole("button", { name: "Spara uppgifterna" }).click();
      await expect.poll(async () => (await db.associationDocument.findUniqueOrThrow({ where: { id: id("E2E-Ledare") } })).visibility).toBe("PUBLIC");

      await page.reload();
      page.once("dialog", (d) => void d.accept());
      const del = page.locator("li", { hasText: "E2E-Inloggade" }).first();
      await del.locator("summary").first().click();
      await del.getByRole("button", { name: "Ta bort dokumentet" }).click();
      await expect.poll(() => db.associationDocument.count({ where: { title: "E2E-Inloggade" } })).toBe(0);
      expect((await page.request.get(`/api/documents/${id("E2E-Inloggade")}`)).status()).toBe(404);
    } finally {
      await db.orgSettings.update({ where: { id: org.id }, data: { aboutIntroSv: original.sv, aboutIntroEn: original.en } });
    }
  });

  test("Ansvarig and members cannot manage the association page", async ({ page }) => {
    await login(page, "ansvarig@ccss.test");
    await page.goto("/sv/manage/association");
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
    await page.goto("/sv/forening");
    await expect(page.getByRole("link", { name: "Redigera sidan" })).toHaveCount(0);
  });
});
