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

test.describe("teams and tournaments", () => {
  test.afterEach(async () => {
    await db.tournament.deleteMany({ where: { name: { startsWith: "E2E-" } } });
    await db.team.deleteMany({ where: { name: { startsWith: "E2E" } } });
  });

  test("a captain creates a team and invites a friend, a leader creates a tournament, the captain registers and withdraws", async ({ page, browser }) => {
    const stamp = Date.now();
    const teamName = `E2E Lag ${stamp}`;
    const tName = `E2E-Turnering ${stamp}`;
    await db.tournament.deleteMany({ where: { name: { startsWith: "E2E-" } } });

    // ---- Maja creates a team and becomes its captain
    await login(page, "member@ccss.test");
    await page.goto("/sv/lag");
    const create = page.getByRole("region", { name: "Skapa ett lag" });
    await create.getByRole("button", { name: "Skapa laget" }).click(); // empty
    await expect(create.getByText("Lagnamnet ska vara mellan 2 och 40 tecken.")).toBeVisible();
    await create.getByLabel("Lagnamn").fill("x");
    await create.getByRole("button", { name: "Skapa laget" }).click();
    await expect(create.getByText("Lagnamnet ska vara mellan 2 och 40 tecken.")).toBeVisible();
    await create.getByLabel("Lagnamn").fill(teamName);
    await create.getByLabel("Tagg").fill("e2e");
    await create.getByLabel("Beskrivning").fill("Vi spelar för skojs skull.");
    await create.getByRole("button", { name: "Skapa laget" }).click();
    await expect(page).toHaveURL(/\/sv\/lag\/[a-z0-9]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(teamName);
    await expect(page.getByText("[E2E]")).toBeVisible();
    await expect(page.locator("li", { hasText: "maja" }).filter({ hasText: "Lagkapten" }).first()).toBeVisible();

    // the name is unique, ignoring case
    await page.goto("/sv/lag");
    await create.getByLabel("Lagnamn").fill(teamName.toLowerCase());
    await create.getByRole("button", { name: "Skapa laget" }).click();
    await expect(create.getByText("Det finns redan ett lag med det namnet.")).toBeVisible();

    // invite Ture by nickname
    await page.getByRole("link", { name: teamName }).first().click();
    const invite = page.getByRole("region", { name: "Bjud in spelare" });
    await invite.getByLabel("Nickname").fill("ingenmedhetsnamnet");
    await invite.getByRole("button", { name: "Bjud in" }).click();
    await expect(invite.getByText("Ingen verifierad användare har det nicknamet.")).toBeVisible();
    await invite.getByLabel("Nickname").fill("ture");
    await invite.getByRole("button", { name: "Bjud in" }).click();
    await expect(invite.getByText("Inbjudan är skickad.")).toBeVisible();
    await expect(invite.getByText("Väntande inbjudningar")).toBeVisible();
    const teamUrl = page.url();
    await logout(page);

    // ---- Ture accepts
    await login(page, "minor@ccss.test");
    await page.goto("/sv/lag");
    const invites = page.getByRole("region", { name: "Inbjudningar till dig" });
    await expect(invites).toContainText(`maja har bjudit in dig till ${teamName}`);
    await invites.getByRole("button", { name: "Tacka ja" }).click();
    await expect(invites).toHaveCount(0); // the invitation disappears once it is answered
    await page.goto(teamUrl);
    await expect(page.getByRole("heading", { name: /Medlemmar \(2\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Lämna laget" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Bjud in spelare" })).toHaveCount(0); // members cannot invite
    await logout(page);

    // ---- a Festivalledare creates a tournament at the event
    await login(page, "leader@ccss.test");
    await page.goto("/sv/manage/tournaments");
    const newT = page.getByRole("region", { name: "Skapa en turnering" });
    await newT.getByLabel("Namn", { exact: true }).fill(tName);
    await newT.getByLabel("Spel", { exact: true }).fill("Rocket League");
    await newT.getByLabel("Beskrivning och regler").fill("Tre mot tre.");
    await newT.getByLabel("Spelare per lag").fill("2");
    await newT.getByLabel("Avbytare", { exact: true }).fill("0");
    await newT.getByLabel("Högst antal lag").fill("8");
    await newT.getByLabel("Anmälan stänger").fill("2099-12-01T12:00");
    await newT.getByLabel(/^Start/).fill("2099-12-02T12:00");
    await newT.getByLabel("Event", { exact: true }).selectOption({ label: "Countryhack" });
    await newT.getByLabel("Status", { exact: true }).selectOption({ label: "Publicerad" });
    await newT.getByRole("button", { name: "Skapa turneringen" }).click();
    await expect.poll(() => db.tournament.count({ where: { name: tName } })).toBe(1);
    const t = await db.tournament.findFirstOrThrow({ where: { name: tName } });
    await expect(page.getByText(tName).first()).toBeVisible();
    await logout(page);

    // ---- a visitor can see the tournament and the team, but not register
    const visitor = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
    await visitor.goto("/sv/turneringar");
    await expect(visitor.getByRole("heading", { name: tName })).toBeVisible();
    await visitor.goto(`/sv/turneringar/${t.slug}`);
    await expect(visitor.getByText("Logga in för att anmäla ett lag.")).toBeVisible();
    await visitor.goto(`/sv/events/${SLUG}`);
    await expect(visitor.getByRole("link", { name: tName })).toBeVisible(); // listed on the event page
    await visitor.goto("/sv/lag");
    await expect(visitor.getByRole("link", { name: teamName })).toBeVisible();
    await visitor.context().close();

    // ---- Ture is not a captain: no registration for him
    await login(page, "minor@ccss.test");
    await page.goto(`/sv/turneringar/${t.slug}`);
    await expect(page.getByText(/Du är inte lagkapten för något lag än/)).toBeVisible();
    await logout(page);

    // ---- Maja registers the team
    await login(page, "member@ccss.test");
    await page.goto(`/sv/turneringar/${t.slug}`);
    await expect(page.getByText("Spelare per lag").first()).toBeVisible();
    const enter = page.getByRole("region", { name: "Anmäl ditt lag" });
    await expect(enter.getByLabel("maja")).toBeChecked(); // the first members are ticked
    await expect(enter.getByLabel("ture")).toBeChecked();
    await enter.getByLabel("ture").uncheck();
    await expect(enter.getByText("1 valda (kravet är 2–2)")).toBeVisible();
    await enter.getByRole("button", { name: "Anmäl laget" }).click();
    await expect(enter.getByText("Truppen har fel antal spelare.")).toBeVisible();
    await enter.getByLabel("ture").check();
    await enter.getByRole("button", { name: "Anmäl laget" }).click();
    await expect.poll(() => db.tournamentRegistration.count({ where: { tournamentId: t.id } })).toBe(1);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Anmälda lag (1)" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Dina anmälningar" })).toContainText(teamName);
    await expect(page.getByRole("region", { name: "Anmälda lag (1)" })).toContainText("maja, ture");

    // withdraw
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("region", { name: "Dina anmälningar" }).getByRole("button", { name: "Ta tillbaka anmälan" }).click();
    await expect.poll(() => db.tournamentRegistration.count({ where: { tournamentId: t.id } })).toBe(0);
    await logout(page);
  });

  test("a draft tournament is hidden from the public; members cannot manage tournaments", async ({ page, browser }) => {
    const leader = await db.user.findUniqueOrThrow({ where: { email: "leader@ccss.test" } });
    const draft = await db.tournament.create({
      data: { slug: `e2e-utkast-${Date.now()}`, name: `E2E-Utkast ${Date.now()}`, game: "Chess", teamSize: 1, registrationClosesAt: new Date("2099-01-01T00:00:00Z"), status: "DRAFT", createdById: leader.id },
    });
    const visitor = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
    expect((await visitor.goto(`/sv/turneringar/${draft.slug}`))?.status()).toBe(404);
    await visitor.goto("/sv/turneringar");
    await expect(visitor.getByText(draft.name)).toHaveCount(0);
    await visitor.context().close();

    await login(page, "member@ccss.test");
    await page.goto("/sv/manage/tournaments");
    await expect(page.getByText("Sidan hittades inte.")).toBeVisible();
    await logout(page);
    await login(page, "admin@ccss.test"); // an Admin holds every right
    await page.goto("/sv/manage/tournaments");
    await expect(page.getByRole("heading", { level: 1, name: "Turneringar" })).toBeVisible();
    await page.goto(`/sv/turneringar/${draft.slug}`);
    await expect(page.getByText("Det här är ett utkast.")).toBeVisible();
  });

  test("the captain can hand over the captaincy and disband the team; a leader can remove a registration", async ({ page }) => {
    const stamp = Date.now();
    const maja = await db.user.findUniqueOrThrow({ where: { email: "member@ccss.test" } });
    const ture = await db.user.findUniqueOrThrow({ where: { email: "minor@ccss.test" } });
    const team = await db.team.create({
      data: { name: `E2E Styrt ${stamp}`, nameKey: `e2e styrt ${stamp}`, captainId: maja.id, members: { create: [{ userId: maja.id }, { userId: ture.id }] } },
    });
    const leader = await db.user.findUniqueOrThrow({ where: { email: "leader@ccss.test" } });
    const t = await db.tournament.create({
      data: { slug: `e2e-t-${stamp}`, name: `E2E-Remove ${stamp}`, game: "Chess", teamSize: 2, maxSubstitutes: 0, registrationClosesAt: new Date("2099-01-01T00:00:00Z"), status: "PUBLISHED", createdById: leader.id },
    });
    await db.tournamentRegistration.create({ data: { tournamentId: t.id, teamId: team.id, registeredById: maja.id, roster: { create: [{ userId: maja.id, tournamentId: t.id }, { userId: ture.id, tournamentId: t.id }] } } });

    // a leader removes the registration
    await login(page, "leader@ccss.test");
    await page.goto(`/sv/turneringar/${t.slug}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Ta bort anmälan" }).click();
    await expect.poll(() => db.tournamentRegistration.count({ where: { tournamentId: t.id } })).toBe(0);
    await page.getByRole("button", { name: "Logga ut" }).click();

    // the captain hands over the captaincy, then Ture (new captain) disbands
    await login(page, "member@ccss.test");
    await page.goto(`/sv/lag/${team.id}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Gör till lagkapten" }).click();
    await expect.poll(async () => (await db.team.findUniqueOrThrow({ where: { id: team.id } })).captainId).toBe(ture.id);
    await page.reload();
    await expect(page.getByRole("button", { name: "Lämna laget" })).toBeVisible(); // Maja is an ordinary member now
    await expect(page.getByRole("button", { name: "Upplös laget" })).toHaveCount(0);
    await page.getByRole("button", { name: "Logga ut" }).click();

    await login(page, "minor@ccss.test");
    await page.goto(`/sv/lag/${team.id}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Upplös laget" }).click();
    await expect(page).toHaveURL(/\/sv\/lag$/);
    expect(await db.team.count({ where: { id: team.id } })).toBe(0);
  });
});
