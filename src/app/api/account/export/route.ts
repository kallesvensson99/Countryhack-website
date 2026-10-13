import { getCurrentUser } from "@/lib/auth/current-user";
import { assertCan, ForbiddenError, UnauthenticatedError } from "@/lib/permissions";
import { exportUserData } from "@/lib/gdpr";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();
    assertCan(user, "account:export", { ownerId: user?.id });
    const data = await exportUserData(user.id);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ccss-my-data.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) return new Response("Unauthorized", { status: 401 });
    if (e instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw e;
  }
}
