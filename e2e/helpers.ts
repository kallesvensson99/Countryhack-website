import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });

/** The seeded users log in many times per run; clear the login rate limiter between tests. */
export async function resetRateLimits() {
  await prisma.rateLimit.deleteMany();
}
