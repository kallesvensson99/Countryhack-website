import { writeFileSync } from "node:fs";
import QRCode from "qrcode";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { db, makeAttendee, resetRateLimits, SLUG } from "./helpers";

test.beforeEach(resetRateLimits);

const FAKE_CAMERA = path.resolve(process.cwd(), "e2e/.tmp/camera.y4m"); // same file the scanner project points Chromium at

/** One-frame-looping Y4M "video" of a QR code on a white background (what the fake webcam films). */
function qrVideo(text: string, w = 640, h = 480, frames = 20): Buffer {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 4;
  const px = Math.floor(Math.min(w, h) / (n + 2 * quiet));
  const size = px * (n + 2 * quiet);
  const ox = Math.floor((w - size) / 2) + quiet * px;
  const oy = Math.floor((h - size) / 2) + quiet * px;
  const y = Buffer.alloc(w * h, 235); // white
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.modules.get(r, c)) for (let dy = 0; dy < px; dy++) y.fill(16, (oy + r * px + dy) * w + ox + c * px, (oy + r * px + dy) * w + ox + (c + 1) * px);
  const chroma = Buffer.alloc((w * h) / 4, 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, chroma, chroma]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F15:1 Ip A1:1 C420jpeg\n`), ...Array.from({ length: frames }, () => frame)]);
}

async function openCheckin(page: Page) {
  const event = await db.event.findUniqueOrThrow({ where: { slug: SLUG } });
  await page.goto("/sv/login");
  await page.getByLabel("E-post").fill("leader@ccss.test");
  await page.getByLabel("Lösenord").fill("Password123!");
  await page.getByRole("button", { name: "Logga in" }).click();
  await expect(page).toHaveURL(/\/sv\/profile/);
  await page.goto(`/sv/manage/events/${event.id}/checkin`);
}

test.describe("camera scanning (fake webcam showing a QR code)", () => {
  test("scans a real ticket QR code, shows the card, then scans the next", async ({ page }) => {
    process.env.APP_SECRET = "e2e-secret-e2e-secret-e2e-secret-123456";
    process.env.APP_URL = "http://localhost:3100";
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/ccss_test";
    const { signTicketToken } = await import("../src/lib/tickets/qr");
    const { ticket } = await makeAttendee("member@ccss.test", { allergies: "nötter" });
    writeFileSync(FAKE_CAMERA, qrVideo(signTicketToken(ticket)));

    await openCheckin(page);
    await page.getByRole("button", { name: "Skanna QR-kod" }).click();
    await expect(page.getByRole("heading", { name: "Maja Medlem" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("nötter")).toBeVisible();
    await expect(page.getByRole("button", { name: "Skanna nästa" })).toBeVisible(); // camera stopped after one code

    await page.getByRole("button", { name: "Checka in" }).click();
    await expect(page.getByText("Incheckad!")).toBeVisible();
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).checkedInAt).not.toBeNull();
  });

  test("a QR code that isn't one of ours is reported, not trusted", async ({ page }) => {
    writeFileSync(FAKE_CAMERA, qrVideo("https://example.com/not-a-ticket"));
    await openCheckin(page);
    await page.getByRole("button", { name: "Skanna QR-kod" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Ogiltig biljettkod." })).toBeVisible({ timeout: 20_000 });
  });
});
