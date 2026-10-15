import { expect, test, type Page } from "@playwright/test";

import { resetRateLimits } from "./helpers";
test.beforeEach(resetRateLimits);

const PASSWORD = "Password123!";
// 1×1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function login(page: Page, email: string) {
  await page.goto("/sv/login");
  await page.getByLabel("E-post").fill(email);
  await page.getByLabel("Lösenord").fill(PASSWORD);
  await page.getByRole("button", { name: "Logga in" }).click();
  await expect(page).toHaveURL(/\/sv\/profile/);
}

test("Festivalledare creates, equips, publishes and duplicates an event; visitors only see it when published", async ({ page, browser }, info) => {
  const name = `E2E-LAN ${info.project.name} ${Date.now()}`;
  await login(page, "leader@ccss.test");

  // create
  await page.goto("/sv/manage/events/new");
  await page.getByLabel("Namn", { exact: true }).fill(name);
  await page.getByLabel("Beskrivning").fill("En testhelg.\nMed två rader.");
  await page.getByLabel("Lokal").fill("Hallen");
  await page.getByLabel("Adress").fill("Gatan 1");
  await page.getByLabel("Start", { exact: true }).fill("2027-07-02T18:00");
  await page.getByLabel("Slut", { exact: true }).fill("2027-07-04T12:00");
  await page.getByLabel("Anmälan öppnar").fill("2027-01-01T08:00");
  await page.getByLabel("Anmälan stänger").fill("2027-07-01T20:00");
  await page.getByRole("button", { name: "Skapa event" }).click();
  await expect(page).toHaveURL(/\/sv\/manage\/events\/[a-z0-9]+$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText("Utkast", { exact: true })).toBeVisible();
  const manageUrl = page.url();

  // times round-trip in Stockholm time
  await expect(page.getByLabel("Start", { exact: true })).toHaveValue("2027-07-02T18:00");

  // the draft is invisible to visitors
  const publicPath = new URL((await page.getByRole("link", { name: "Visa publik sida" }).getAttribute("href"))!, page.url()).pathname;
  const visitorCtx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: "sv-SE" });
  const visitor = await visitorCtx.newPage();
  await visitor.goto(publicPath);
  await expect(visitor.getByText("Sidan hittades inte.")).toBeVisible();

  // ticket types: one public, one hidden
  await page.getByRole("link", { name: "Biljettyper" }).click();
  const newForm = page.locator("section[aria-labelledby=new-h]");
  await newForm.getByLabel("Namn").fill("Standard");
  await newForm.getByLabel("Pris (kr)").fill("149,50");
  await newForm.getByLabel("Antal biljetter").fill("20");
  await newForm.getByRole("button", { name: "Lägg till biljettyp" }).click();
  await expect(newForm.getByText("Biljettypen är sparad.")).toBeVisible();
  await expect(page.getByText("Standard · 149,50 kr")).toBeVisible();

  await newForm.getByLabel("Namn").fill("Hemlig crew");
  await newForm.getByLabel("Pris (kr)").fill("0");
  await newForm.getByLabel(/^Dold/).check();
  await newForm.getByRole("button", { name: "Lägg till biljettyp" }).click();
  await expect(page.getByText("Hemlig crew · 0 kr")).toBeVisible();

  // bad price is rejected with a message
  await newForm.getByLabel("Namn").fill("Fel");
  await newForm.getByLabel("Pris (kr)").fill("gratis");
  await newForm.getByRole("button", { name: "Lägg till biljettyp" }).click();
  await expect(newForm.getByText("Ange ett pris i kronor")).toBeVisible();

  // publish
  await page.goto(manageUrl);
  await page.getByRole("button", { name: "Publicera" }).click();
  await expect(page.getByText("Publicerat", { exact: true })).toBeVisible(); // the badge is the feedback; the button unmounts
  await expect(page.getByRole("button", { name: "Publicera" })).toHaveCount(0);

  // now visitors see the event, the public ticket, but not the hidden one
  await visitor.goto(publicPath);
  await expect(visitor.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(visitor.getByRole("heading", { name: "Standard" })).toBeVisible();
  await expect(visitor.getByText("149,50 kr")).toBeVisible();
  await expect(visitor.getByText("20 kvar")).toBeVisible();
  await expect(visitor.getByText("Hemlig crew")).toHaveCount(0);
  await visitor.goto("/sv/events");
  await expect(visitor.getByRole("link", { name })).toBeVisible();
  await visitorCtx.close();

  // duplicate → new draft with the ticket types
  await page.getByRole("button", { name: "Duplicera som utkast" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${name} (kopia)` })).toBeVisible();
  await expect(page.getByText("Utkast", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Biljettyper" }).click();
  await expect(page.getByText("Standard · 149,50 kr")).toBeVisible();
  await expect(page.getByText("Hemlig crew · 0 kr")).toBeVisible();

  // image upload on the copy
  await page.goBack();
  await page.locator("input[type=file]").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Ladda upp bild" }).click();
  await expect(page.getByText("Bilden är sparad.")).toBeVisible();
  const src = await page.locator("main img").first().getAttribute("src");
  expect(src).toMatch(/^\/uploads\/events\/[a-f0-9]{32}\.png$/);
  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");

  // a text file posing as an image is refused
  await page.locator("input[type=file]").setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") });
  await page.getByRole("button", { name: "Ladda upp bild" }).click();
  await expect(page.getByText("Filen måste vara en PNG-, JPEG- eller WebP-bild.")).toBeVisible();
});

test("validation errors keep what was typed; plain members can't manage events", async ({ page }) => {
  await login(page, "leader@ccss.test");
  await page.goto("/sv/manage/events/new");
  await page.getByLabel("Namn", { exact: true }).fill("Felaktigt event");
  await page.getByLabel("Beskrivning").fill("x");
  await page.getByLabel("Lokal").fill("Hallen");
  await page.getByLabel("Adress").fill("Gatan 1");
  await page.getByLabel("Anmälan öppnar").fill("2027-01-01T08:00");
  await page.getByLabel("Anmälan stänger").fill("2027-06-30T20:00");
  await page.getByLabel("Start", { exact: true }).fill("2027-07-02T18:00");
  await page.getByLabel("Slut", { exact: true }).fill("2027-07-01T12:00"); // before start
  await page.getByRole("button", { name: "Skapa event" }).click();
  await expect(page.getByText("Datumen står i fel ordning.")).toBeVisible();
  await expect(page.getByLabel("Namn", { exact: true })).toHaveValue("Felaktigt event");
  await expect(page.getByLabel("Start", { exact: true })).toHaveValue("2027-07-02T18:00");

  await page.context().clearCookies();
  await login(page, "member@ccss.test");
  for (const path of ["/sv/manage/events", "/sv/manage/events/new"]) {
    await page.goto(path);
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
  }
});

test("the seeded example event is public with its tickets", async ({ page }) => {
  await page.goto("/sv/events/ccss-lan-hostlan");
  await expect(page.getByRole("heading", { level: 1, name: "Countryhack" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Standard med plats" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "VIP-plats" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Besökare / utan plats" })).toBeVisible();
  await expect(page.getByText("Crew", { exact: true })).toHaveCount(0);
  await page.goto("/en/events/ccss-lan-hostlan");
  await expect(page.getByText("Includes a seat").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
