import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { copyChart } from "../src/lib/seating/copy";

const db = new PrismaClient();

/** Development-only credentials. Printed in the README. Never run this against production. */
export const SEED_PASSWORD = "Password123!";

const users = [
  { email: "admin@ccss.test", realName: "Admin Adminsson", nickname: "admin", birth: "1990-05-10", tags: ["ADMIN"] as const, verified: true },
  { email: "leader@ccss.test", realName: "Frida Festivalledare", nickname: "frida", birth: "1992-03-21", tags: ["FESTIVALLEDARE"] as const, verified: true },
  { email: "member@ccss.test", realName: "Maja Medlem", nickname: "maja", birth: "1998-11-02", tags: [] as const, verified: true },
  {
    email: "minor@ccss.test",
    realName: "Ture Tonåring",
    nickname: "ture",
    birth: `${new Date().getFullYear() - 15}-06-15`,
    tags: [] as const,
    verified: true,
    guardianName: "Greta Tonåring",
    guardianPhone: "+46 70 123 45 67",
  },
  { email: "unverified@ccss.test", realName: "Ove Overifierad", nickname: "ove", birth: "1995-01-30", tags: [] as const, verified: false },
];

async function main() {
  if (process.env.NODE_ENV === "production" && !process.env.ALLOW_SEED) throw new Error("Refusing to seed test users in production.");

  const settings = (await db.orgSettings.findFirst()) ?? (await db.orgSettings.create({ data: {} }));
  // a contact address so the FAQ and crew pages have something to show in development
  if (!settings.contactEmail) await db.orgSettings.update({ where: { id: settings.id }, data: { contactEmail: "info@ccss.test" } });

  const passwordHash = await hashPassword(SEED_PASSWORD);
  for (const u of users) {
    const user = await db.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        passwordHash,
        realName: u.realName,
        nickname: u.nickname,
        birthDate: new Date(`${u.birth}T00:00:00.000Z`),
        phone: "+46 70 000 00 00",
        locale: "sv",
        emailVerifiedAt: u.verified ? new Date() : null,
        guardianName: "guardianName" in u ? u.guardianName : null,
        guardianPhone: "guardianPhone" in u ? u.guardianPhone : null,
        consents: { create: { kind: "PRIVACY_POLICY", version: "1" } },
      },
    });
    for (const tag of u.tags) {
      await db.userTag.upsert({ where: { userId_tag: { userId: user.id, tag } }, update: {}, create: { userId: user.id, tag } });
    }
  }
  await seedExampleEvent();
  console.log(`Seeded ${users.length} users (password: ${SEED_PASSWORD}).`);
}

/** One published example event (later stages add chart, food and discount code to it). */
async function seedExampleEvent() {
  const slug = "ccss-lan-hostlan";
  const existing = await db.event.findUnique({ where: { slug }, include: { chart: true } });
  if (existing) {
    if (!existing.chart) await seedChart(existing.id);
    await seedCommerce(existing.id);
    return;
  }
  const leader = await db.user.findUniqueOrThrow({ where: { email: "leader@ccss.test" } });
  const day = 24 * 3600_000;
  const start = new Date(Date.now() + 60 * day);
  start.setUTCHours(16, 0, 0, 0); // ≈ 18:00 Swedish time
  while (start.getUTCDay() !== 5) start.setUTCDate(start.getUTCDate() + 1); // a Friday, so the meal names (Fredag…Söndag) fit
  const hours = (n: number) => new Date(start.getTime() + n * 3600_000);
  const event = await db.event.create({
    data: {
      slug,
      name: "CCSS Höst-LAN",
      description: "Tre dagar med spel, mat och gemenskap!\nMedtag egen dator, headset och sovsäck.",
      venueName: "Folkets Hus",
      address: "Storgatan 1, 123 45 Exempelstad",
      startsAt: start,
      endsAt: hours(48),
      registrationOpensAt: new Date(Date.now() - 7 * day),
      registrationClosesAt: hours(-24),
      seatChangeDeadline: hours(-12),
      minAge: 14,
      status: "PUBLISHED",
      showNicknamesOnMap: true,
      createdById: leader.id,
      ticketTypes: {
        create: [
          { name: "Standard med plats", description: "Helhelg med plats vid långbord.", priceOre: 15000, quantity: 80, includesSeat: true, sortOrder: 1 },
          { name: "VIP-plats", description: "Plats i VIP-zonen med extra utrymme.", priceOre: 25000, quantity: 10, includesSeat: true, sortOrder: 2 },
          { name: "Besökare / utan plats", description: "Kom och hälsa på, utan egen plats.", priceOre: 5000, quantity: 30, includesSeat: false, sortOrder: 3 },
          { name: "Crew", description: "För funktionärer.", priceOre: 0, quantity: 15, includesSeat: true, hidden: true, requiresDiscountCode: true, sortOrder: 4 },
        ],
      },
    },
  });
  await seedChart(event.id);
  await seedCommerce(event.id);
}

/** Two zones, 60 seats (5 standard rows of 10 + a VIP row of 10), stage, entrance, kitchen, toilets; plus a template. */
async function seedChart(eventId: string) {
  const chart = await db.seatingChart.create({ data: { eventId, name: "Folkets Hus – stora salen", width: 1200, height: 800, gridSize: 20 } });
  const standard = await db.seatZone.create({ data: { chartId: chart.id, name: "Standard", color: "#0072B2" } });
  const vip = await db.seatZone.create({ data: { chartId: chart.id, name: "VIP", color: "#E69F00" } });

  const seats: { chartId: string; label: string; x: number; y: number; zoneId: string; groupId: string }[] = [];
  for (const [r, row] of ["A", "B", "C", "D", "E"].entries()) {
    for (let i = 1; i <= 10; i++) seats.push({ chartId: chart.id, label: `${row}${i}`, x: 300 + (i - 1) * 40, y: 240 + r * 40, zoneId: standard.id, groupId: `row-${row}` });
  }
  for (let i = 1; i <= 10; i++) seats.push({ chartId: chart.id, label: `V${i}`, x: 300 + (i - 1) * 40, y: 480, zoneId: vip.id, groupId: "row-V" });
  await db.seat.createMany({ data: seats });

  await db.chartObject.createMany({
    data: [
      { chartId: chart.id, kind: "STAGE", x: 240, y: 40, width: 400, height: 100, rotation: 0 },
      { chartId: chart.id, kind: "ENTRANCE", x: 60, y: 680, width: 120, height: 40, rotation: 0 },
      { chartId: chart.id, kind: "KITCHEN", x: 960, y: 40, width: 180, height: 120, rotation: 0 },
      { chartId: chart.id, kind: "TOILET", x: 1000, y: 280, width: 80, height: 60, rotation: 0, label: "WC 1" },
      { chartId: chart.id, kind: "TOILET", x: 1000, y: 360, width: 80, height: 60, rotation: 0, label: "WC 2" },
    ],
  });

  // Seat-bearing ticket types may use the matching zones; Crew may sit anywhere; Besökare has no seat.
  const types = await db.ticketType.findMany({ where: { eventId } });
  const link = async (name: string, zones: string[]) => {
    const tt = types.find((t) => t.name === name);
    if (tt) await db.ticketTypeZone.createMany({ data: zones.map((zoneId) => ({ ticketTypeId: tt.id, zoneId })), skipDuplicates: true });
  };
  await link("Standard med plats", [standard.id]);
  await link("VIP-plats", [vip.id]);
  await link("Crew", [standard.id, vip.id]);

  if (!(await db.seatingChart.findFirst({ where: { isTemplate: true, name: "Standardmall (60 platser)" } }))) {
    await db.$transaction((tx) => copyChart(tx, chart.id, { name: "Standardmall (60 platser)", eventId: null, isTemplate: true }));
  }
}

/** Meals, three food packages with variants, and two discount codes (CREW unlocks the hidden Crew ticket). */
async function seedCommerce(eventId: string) {
  if ((await db.meal.count({ where: { eventId } })) === 0) {
    const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
    const at = (h: number) => new Date(event.startsAt.getTime() + h * 3600_000);
    const mk = (name: string, h: number) => db.meal.create({ data: { eventId, name, servedAt: at(h) } });
    const fri = await mk("Fredagsmiddag", 1);
    const satB = await mk("Lördagsfrukost", 15);
    const satL = await mk("Lördagslunch", 19);
    const satD = await mk("Lördagsmiddag", 25);
    const sunB = await mk("Söndagsfrukost", 39);
    const variants = [{ name: "Standard", sortOrder: 0 }, { name: "Vegetarisk", sortOrder: 1 }, { name: "Vegansk", sortOrder: 2 }];
    const deadline = new Date(event.startsAt.getTime() - 3 * 24 * 3600_000);
    const pkg = (name: string, description: string, priceOre: number, quantity: number | null, sortOrder: number, meals: string[]) =>
      db.foodPackage.create({ data: { eventId, name, description, priceOre, quantity, sortOrder, salesEndsAt: deadline, meals: { create: meals.map((mealId) => ({ mealId })) }, variants: { create: variants } } });
    await pkg("Helhelg", "Alla måltider från fredagsmiddag till söndagsfrukost.", 45000, 60, 1, [fri.id, satB.id, satL.id, satD.id, sunB.id]);
    await pkg("Fredagsmiddag", "Middag på fredagen.", 9000, null, 2, [fri.id]);
    await pkg("Frukostpaket", "Frukost lördag och söndag.", 12000, null, 3, [satB.id, sunB.id]);
  }
  if ((await db.discountCode.count({ where: { eventId } })) === 0) {
    const crew = await db.ticketType.findFirst({ where: { eventId, name: "Crew" } });
    await db.discountCode.create({ data: { eventId, code: "CREW", kind: "PERCENT", value: 100, appliesTo: "ALL", maxUses: 15, ticketTypes: crew ? { create: [{ ticketTypeId: crew.id }] } : undefined } });
    await db.discountCode.create({ data: { eventId, code: "EARLY10", kind: "PERCENT", value: 10, appliesTo: "ALL" } });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
