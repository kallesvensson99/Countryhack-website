import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });
import { resetRateLimits } from "./helpers";
test.beforeEach(resetRateLimits);
test.afterAll(() => db.$disconnect());

const PASSWORD = "Password123!";

async function login(page: Page, email: string, password = PASSWORD, expectSuccess = true) {
  await page.goto("/sv/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Lösenord").fill(password);
  await page.getByRole("button", { name: "Logga in" }).click();
  if (expectSuccess) await expect(page).toHaveURL(/\/sv\/profile/);
}

test("visitor sees Swedish UI by default, can switch to English, and reads the privacy policy", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sv$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Höst-LAN"); // the landing page features the next event
  await page.getByRole("link", { name: "EN", exact: true }).click();
  await expect(page).toHaveURL(/\/en$/);
  await page.getByRole("link", { name: "Privacy policy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
});

test("register → verify email → profile, with guardian fields for a minor", async ({ page }, info) => {
  const tag = `${info.project.name}${Date.now()}`;
  const email = `e2e-${tag}@example.test`;
  const year = new Date().getFullYear() - 15;

  await page.goto("/sv/register");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Lösenord").fill("a-very-long-password");
  await page.getByLabel("Namn", { exact: true }).fill("E2E Tester");
  await page.getByLabel("Nickname").fill(`e2e${tag}`);
  await page.getByLabel("Födelsedatum").fill(`${year}-05-05`);
  await page.getByLabel("Telefon", { exact: true }).fill("070 123 45 67");

  // Minor → guardian fields appear and are required
  await expect(page.getByLabel("Målsmans namn")).toBeVisible();
  await page.getByRole("button", { name: "Skapa konto" }).click();
  await expect(page.getByText("Du måste godkänna integritetspolicyn.")).toBeVisible();
  await expect(page.getByText("Målsmans uppgifter krävs").first()).toBeVisible();

  await expect(page.getByLabel("E-post")).toHaveValue(email); // typed values survive a failed submit
  await page.getByLabel("Lösenord").fill("a-very-long-password"); // ...but the password is never echoed back
  await page.getByLabel("Målsmans namn").fill("Gun Guardian");
  await page.getByLabel("Målsmans telefon").fill("070 765 43 21");
  await page.getByLabel("Jag har läst och godkänner integritetspolicyn").check();
  await page.getByRole("button", { name: "Skapa konto" }).click();
  await expect(page.getByRole("heading", { name: "Konto skapat" })).toBeVisible();

  // Unverified accounts see the banner on the profile page
  await page.goto("/sv/profile");
  await expect(page.getByText("Din e-postadress är inte bekräftad")).toBeVisible();

  // Follow the verification link from the outbox
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { to: email, template: "verify-email" } });
  const url = new URL((mail.payload as { url: string }).url);
  await page.goto(url.pathname + url.search);
  await page.getByRole("button", { name: "Bekräfta e-post" }).click();
  await expect(page.getByText("Din e-postadress är bekräftad.")).toBeVisible();

  await page.goto("/sv/profile");
  await expect(page.getByText("Din e-postadress är inte bekräftad")).toHaveCount(0);
  await expect(page.getByLabel("Målsmans namn")).toHaveValue("Gun Guardian");
});

test("login failures are generic; seeded member logs in and can download their data", async ({ page }) => {
  await login(page, "member@ccss.test", "wrong-password", false);
  await expect(page.getByText("Fel e-post eller lösenord.")).toBeVisible();

  await login(page, "member@ccss.test");
  await expect(page).toHaveURL(/\/sv\/profile/);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Ladda ner mina uppgifter" }).click()]);
  expect(download.suggestedFilename()).toBe("ccss-my-data.json");
});

test("a plain member can't reach admin pages, but the admin can", async ({ page }) => {
  await login(page, "member@ccss.test");
  await expect(page).toHaveURL(/\/sv\/profile/);
  await page.goto("/sv/admin/users");
  await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
  await page.goto("/sv/admin/settings");
  await expect(page.getByText("Sidan hittades inte.")).toBeVisible();

  await page.context().clearCookies();
  await login(page, "admin@ccss.test");
  await page.goto("/sv/admin/users");
  await expect(page.getByRole("heading", { name: "Användare" })).toBeVisible();
});

test("admin edits org settings and the footer shows them", async ({ page }, info) => {
  await login(page, "admin@ccss.test");
  await page.goto("/sv/admin/settings");
  const orgNumber = `802000-${info.project.name === "mobile" ? "0002" : "0001"}`;
  await page.getByLabel("Organisationsnummer").fill(orgNumber);
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByText("Inställningarna är sparade.")).toBeVisible();
  await page.goto("/sv");
  await expect(page.locator("footer")).toContainText(orgNumber);
});

test("the last admin can't be demoted", async ({ page }) => {
  await login(page, "admin@ccss.test");
  await page.goto("/sv/admin/users?q=admin");
  await page.getByRole("button", { name: /Ta bort rollen Admin/ }).click();
  await expect(page.getByText("Det måste alltid finnas minst en administratör.")).toBeVisible();
});

test("mobile layout has no horizontal scroll on key pages", async ({ page }) => {
  for (const path of ["/sv", "/sv/login", "/sv/register", "/sv/privacy"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, path).toBe(false);
  }
});
