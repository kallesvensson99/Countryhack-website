import { expect, test } from "@playwright/test";
import { db, SLUG } from "./helpers";

const noHorizontalScroll = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe("landing page", () => {
  test("features the next event with facts and its public tickets", async ({ page }) => {
    await page.goto("/sv");
    await expect(page.getByRole("heading", { level: 1, name: "CCSS Höst-LAN" })).toBeVisible();
    await expect(page.getByText("Nästa LAN")).toBeVisible();
    await expect(page.getByRole("link", { name: "Köp biljett" }).first()).toHaveAttribute("href", `/sv/events/${SLUG}`);

    const facts = page.getByRole("region", { name: "Fakta om eventet" });
    await expect(facts).toContainText("Folkets Hus");
    await expect(facts).toContainText("14 år");
    await expect(facts).toContainText("av 60 lediga"); // seats

    // tickets: public types only, with prices and a link to buy
    const tickets = page.getByRole("region", { name: "Biljetter" });
    await expect(tickets.getByRole("heading", { name: "Standard med plats" })).toBeVisible();
    await expect(tickets.getByRole("heading", { name: "VIP-plats" })).toBeVisible();
    await expect(tickets.getByRole("heading", { name: "Besökare / utan plats" })).toBeVisible();
    await expect(tickets.getByText("Crew")).toHaveCount(0); // hidden
    await expect(tickets.getByText("150 kr")).toBeVisible();
    await expect(tickets.getByText("250 kr")).toBeVisible();
    await expect(tickets.getByRole("link", { name: /Välj biljett: VIP-plats/ })).toHaveAttribute("href", `/sv/events/${SLUG}`);

    // how it works + links to the other pages
    await expect(page.getByRole("heading", { name: "Så går det till" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Bli crew" }).last()).toHaveAttribute("href", "/sv/crew");
    await expect(page.getByRole("link", { name: "Vanliga frågor" }).last()).toHaveAttribute("href", "/sv/faq");
  });

  test("structured data describes the event and its offers", async ({ page }) => {
    await page.goto("/sv");
    const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
    const ld = JSON.parse(raw!);
    expect(ld["@type"]).toBe("Event");
    expect(ld.name).toBe("CCSS Höst-LAN");
    expect(ld.location.name).toBe("Folkets Hus");
    expect(ld.offers.map((o: { name: string }) => o.name)).toEqual(["Standard med plats", "VIP-plats", "Besökare / utan plats"]);
    expect(ld.offers[0]).toMatchObject({ price: "150.00", priceCurrency: "SEK" });
  });

  test("works in English too", async ({ page }) => {
    await page.goto("/en");
    await expect(page.getByRole("heading", { level: 1, name: "CCSS Höst-LAN" })).toBeVisible();
    await expect(page.getByText("Next LAN")).toBeVisible();
    await expect(page.getByRole("region", { name: "Event facts" })).toContainText("14 years");
    await expect(page.getByRole("region", { name: "Tickets" }).getByText("SEK 150")).toBeVisible();
    await expect(page.getByRole("link", { name: "Join the crew" }).last()).toHaveAttribute("href", "/en/crew");
  });

  test("the header links to the FAQ and the crew page; the layout fits a phone", async ({ page }) => {
    for (const path of ["/sv", "/sv/faq", "/sv/crew", "/en"]) {
      await page.goto(path);
      expect(await noHorizontalScroll(page), path).toBe(false);
    }
    await page.goto("/sv");
    const nav = page.getByRole("navigation", { name: "Huvudnavigering" });
    await nav.getByRole("link", { name: "Vanliga frågor" }).click();
    await expect(page).toHaveURL(/\/sv\/faq$/);
    await page.getByRole("navigation", { name: "Huvudnavigering" }).getByRole("link", { name: "Bli crew" }).click();
    await expect(page).toHaveURL(/\/sv\/crew$/);
  });

  test("a logged-in member doesn't get the sign-up button", async ({ page }) => {
    await db.rateLimit.deleteMany();
    await page.goto("/sv/login");
    await page.getByLabel("E-post").fill("member@ccss.test");
    await page.getByLabel("Lösenord").fill("Password123!");
    await page.getByRole("button", { name: "Logga in" }).click();
    await expect(page).toHaveURL(/profile/);
    await page.goto("/sv");
    await expect(page.getByRole("heading", { level: 1, name: "CCSS Höst-LAN" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Skapa konto" })).toHaveCount(0);
  });
});

test.describe("FAQ", () => {
  test("answers are collapsed until opened, with the live age limit and contact address", async ({ page }) => {
    await page.goto("/sv/faq");
    await expect(page.getByRole("heading", { level: 1, name: "Vanliga frågor" })).toBeVisible();
    for (const group of ["Biljetter och betalning", "Plats och mat", "På plats", "Konto och personuppgifter"]) await expect(page.getByRole("heading", { name: group })).toBeVisible();

    const age = page.locator("details#q-age");
    await expect(age).not.toHaveAttribute("open", "");
    await expect(age.getByText("Åldersgränsen är 14 år")).toBeHidden();
    await age.locator("summary").click();
    await expect(age.getByText("Åldersgränsen är 14 år")).toBeVisible();
    await expect(age.getByText("målsman")).toBeVisible();

    await page.locator("details#q-refund summary").click();
    await expect(page.locator("details#q-refund")).toContainText("info@ccss.test");
    await expect(page.getByRole("link", { name: "info@ccss.test" })).toHaveAttribute("href", "mailto:info@ccss.test");
  });

  test("works by keyboard and from a section link", async ({ page }) => {
    await page.goto("/sv/faq");
    const summary = page.locator("details#q-food summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("details#q-food")).toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(page.locator("details#q-food")).not.toHaveAttribute("open", "");

    await page.getByRole("navigation", { name: "Hoppa till avsnitt" }).getByRole("link", { name: "På plats" }).click();
    await expect(page).toHaveURL(/#faq-onSite$/);
    await expect(page.getByRole("heading", { name: "På plats" })).toBeInViewport();
  });

  test("structured data lists every question; English works", async ({ page }) => {
    await page.goto("/en/faq");
    await expect(page.getByRole("heading", { level: 1, name: "Frequently asked questions" })).toBeVisible();
    await page.locator("details#q-age summary").click();
    await expect(page.locator("details#q-age")).toContainText("The age limit is 14");
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity).toHaveLength(18);
    expect(ld.mainEntity[0]).toMatchObject({ "@type": "Question", acceptedAnswer: { "@type": "Answer" } });
  });

  test("the age answer follows the event's age limit", async ({ page }) => {
    const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
    await db.event.update({ where: { id: event.id }, data: { minAge: 16 } });
    try {
      await page.goto("/sv/faq");
      await page.locator("details#q-age summary").click();
      await expect(page.locator("details#q-age")).toContainText("Åldersgränsen är 16 år");
    } finally {
      await db.event.update({ where: { id: event.id }, data: { minAge: 14 } });
    }
  });
});

test.describe("crew page", () => {
  test("lists the jobs and explains how to apply, with a ready-made email", async ({ page }) => {
    await page.goto("/sv/crew");
    await expect(page.getByRole("heading", { level: 1, name: "Bli crew" })).toBeVisible();
    await expect(page.getByRole("note").first()).toContainText("CCSS Höst-LAN");
    const jobs = page.getByRole("region", { name: "Uppgifter vi behöver hjälp med" });
    for (const j of ["Incheckning och information", "Kök och mat", "Teknik och nätverk", "Värdar och trygghet", "Uppbyggnad och nedrivning"]) await expect(jobs.getByRole("heading", { name: j })).toBeVisible();
    await expect(jobs.getByText("Före").first()).toBeVisible();

    const apply = page.getByRole("link", { name: "Anmäl intresse via e-post" }).first();
    const href = (await apply.getAttribute("href"))!;
    const url = new URL(href);
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("info@ccss.test");
    expect(url.searchParams.get("subject")).toBe("Crew: CCSS Höst-LAN");
    expect(url.searchParams.get("body")).toContain("Uppgift jag är intresserad av:");
    await expect(page.getByText("Mejla oss på info@ccss.test")).toBeVisible();
    await expect(page.getByText("Har du inget konto än?")).toBeVisible();
  });

  test("English version and links to the FAQ", async ({ page }) => {
    await page.goto("/en/crew");
    await expect(page.getByRole("heading", { level: 1, name: "Join the crew" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Kitchen and food" })).toBeVisible();
    await page.getByRole("link", { name: "More questions? See the FAQ" }).click();
    await expect(page).toHaveURL(/\/en\/faq$/);
  });

  test("without a contact address it says so instead of showing a dead button", async ({ page }) => {
    const org = await db.orgSettings.findFirstOrThrow();
    await db.orgSettings.update({ where: { id: org.id }, data: { contactEmail: null } });
    try {
      await page.goto("/sv/crew");
      await expect(page.getByRole("link", { name: "Anmäl intresse via e-post" })).toHaveCount(0);
      await expect(page.getByText("Föreningens kontaktuppgifter är inte inlagda än")).toBeVisible();
      await page.goto("/sv/faq");
      await page.locator("details#q-contact summary").click();
      await expect(page.locator("details#q-contact")).toContainText("föreningens kontaktuppgifter");
    } finally {
      await db.orgSettings.update({ where: { id: org.id }, data: { contactEmail: org.contactEmail } });
    }
  });
});
