import { headers } from "next/headers";
import { env } from "../env";

export async function getClientIp(): Promise<string | null> {
  const h = await headers();
  // Caddy sets X-Forwarded-For; the first entry is the client.
  const xff = h.get("x-forwarded-for");
  return xff?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

export async function getUserAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}

/** For route handlers that change data: reject cross-origin requests. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(env().APP_URL).origin;
  } catch {
    return false;
  }
}
