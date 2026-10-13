import { PrismaClient } from "@prisma/client";

/** Fresh rate-limit counters per run, otherwise repeated runs lock the seed users out. */
export default async function globalSetup() {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });
  await db.rateLimit.deleteMany();
  await db.$disconnect();
}
