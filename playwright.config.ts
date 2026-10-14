import { defineConfig, devices } from "@playwright/test";

const port = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  retries: 0,
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    // Production build against the *test* database, with a fresh seed.
    command: `npx prisma migrate deploy && npx tsx prisma/seed.ts && npx next build && npx next start -p ${port}`,
    url: `http://localhost:${port}/api/health`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test",
      APP_URL: `http://localhost:${port}`,
      APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-123456",
      NODE_ENV: "production",
      ALLOW_SEED: "1", // the seed refuses to run in production otherwise
      PAYMENT_PROVIDER: "mock", // fake checkout page instead of Stripe (only works on localhost)
    },
  },
});
