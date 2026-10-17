import { getCurrentUser } from "@/lib/auth/current-user";
import { readDocument } from "@/lib/association/service";

export const dynamic = "force-dynamic";

/** Downloads an association document, if the viewer is allowed to see it (anything else is a plain 404). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const found = await readDocument(user, id);
  if (!found) return new Response("Not found", { status: 404 });
  const { doc, data } = found;
  const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": doc.contentType,
      "Content-Length": String(data.length),
      // Always a download, never rendered in the page's origin.
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": doc.visibility === "PUBLIC" ? "public, max-age=0, must-revalidate" : "private, no-store",
    },
  });
}
