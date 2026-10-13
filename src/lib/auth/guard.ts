import { getLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { redirect } from "@/i18n/navigation";
import { can, type Action, type Resource } from "../permissions";
import { getCurrentUser } from "./current-user";
import type { SessionUser } from "./sessions";

/** Page-level guard: login required (redirects), then permission required (404 so we don't leak that the page exists). */
export async function requirePage(action?: Action, resource?: Resource): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect({ href: "/login", locale: await getLocale() });
  if (action && !can(user, action, resource)) notFound();
  return user as SessionUser;
}
