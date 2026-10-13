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
  console.log(`Seeded ${users.length} users (password: ${SEED_PASSWORD}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
