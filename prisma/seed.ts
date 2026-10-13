import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";

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
  void settings;

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
  if (await db.event.findUnique({ where: { slug } })) return;
  const leader = await db.user.findUniqueOrThrow({ where: { email: "leader@ccss.test" } });
  const day = 24 * 3600_000;
  const start = new Date(Date.now() + 60 * day);
  start.setUTCHours(16, 0, 0, 0); // ≈ 18:00 Swedish time
  const hours = (n: number) => new Date(start.getTime() + n * 3600_000);
  await db.event.create({
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
