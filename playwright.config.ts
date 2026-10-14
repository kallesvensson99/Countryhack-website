import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = 3100;

// Fake camera for the QR-scanner test: Chromium plays this Y4M file as the webcam. The spec overwrites it with a ticket QR.
const FAKE_CAMERA = path.resolve(process.cwd(), "e2e/.tmp/camera.y4m"); // tests run from the repo root
mkdirSync(path.dirname(FAKE_CAMERA), { recursive: true });
if (!existsSync(FAKE_CAMERA)) {
  const w = 64, h = 48;
  writeFileSync(FAKE_CAMERA, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F15:1 Ip A1:1 C420jpeg
FRAME
`), Buffer.alloc(w * h, 235), Buffer.alloc((w * h) / 2, 128)]));
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  retries: 0,
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testIgnore: /scan.spec.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", testIgnore: /scan.spec.ts/, use: { ...devices["Pixel 7"] } },
    {
      name: "scanner",
      testMatch: /scan.spec.ts/,
      use: {
        ...devices["Pixel 7"],
        permissions: ["camera"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${FAKE_CAMERA}`] },
      },
    },
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
