import { CONTENT_TYPES, KEY_PATTERN, getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

// In production Caddy serves /uploads straight from the volume; this handler covers development.
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const key = (await params).path.join("/");
  if (!KEY_PATTERN.test(key)) return new Response("Not found", { status: 404 });
  const data = await getStorage().read(key);
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": CONTENT_TYPES[key.split(".").pop()!] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable", // filenames are random and never reused
      "X-Content-Type-Options": "nosniff",
    },
  });
}
