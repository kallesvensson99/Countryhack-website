"use server";

import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { getCurrentUser, clearSessionCookie, setSessionCookie } from "@/lib/auth/current-user";
import { getClientIp, getUserAgent } from "@/lib/auth/request";
import { deleteSessionByToken, SESSION_COOKIE } from "@/lib/auth/sessions";
import { loginUser, registerUser, requestPasswordReset, resendVerification, resetPassword, verifyEmailToken } from "@/lib/auth/service";
import {
  echoValues,
  fieldErrors,
  forgotPasswordSchema,
  formToObject,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  type ActionState,
} from "@/lib/validation/account";

export async function registerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const locale = await getLocale();
  const result = await registerUser(parsed.data, { ip: await getClientIp(), locale });
  if (!result.ok) return { errors: result.errors, values };

  // Log the new user straight in; they can browse but not buy until verified.
  const login = await loginUser(parsed.data.email, parsed.data.password, { ip: await getClientIp(), userAgent: await getUserAgent() });
  if (login.ok) await setSessionCookie(login.token, login.expiresAt);
  redirect({ href: "/register/done", locale });
  return {};
}

export async function loginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const result = await loginUser(parsed.data.email, parsed.data.password, { ip: await getClientIp(), userAgent: await getUserAgent() });
  if (!result.ok) return { message: result.reason === "rateLimited" ? "messages.rateLimited" : "messages.invalidCredentials", values };
  await setSessionCookie(result.token, result.expiresAt);
  redirect({ href: "/profile", locale: await getLocale() });
  return {};
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSessionByToken(token);
  await clearSessionCookie();
  redirect({ href: "/", locale: await getLocale() });
}

export async function forgotPasswordAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = forgotPasswordSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const r = await requestPasswordReset(parsed.data.email, { ip: await getClientIp(), locale: await getLocale() });
  if (r.rateLimited) return { message: "messages.rateLimited", values };
  return { ok: true, message: "messages.resetEmailSent", values };
}

export async function resetPasswordAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = resetPasswordSchema.safeParse(formToObject(fd));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  const ok = await resetPassword(parsed.data.token, parsed.data.password);
  if (!ok) return { message: "messages.tokenInvalid" };
  redirect({ href: "/login?reset=1", locale: await getLocale() });
  return {};
}

export async function verifyEmailAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const token = String(fd.get("token") ?? "");
  const ok = token.length > 10 && (await verifyEmailToken(token));
  return ok ? { ok: true, message: "messages.emailVerified" } : { message: "messages.tokenInvalid" };
}

export async function resendVerificationAction(_prev: ActionState): Promise<ActionState> {
  const user = await getCurrentUser();
  if (!user) return { message: "messages.mustLogin" };
  const r = await resendVerification(user.id, { ip: await getClientIp(), locale: await getLocale() });
  if (r === "rateLimited") return { message: "messages.rateLimited" };
  if (r === "alreadyVerified") return { ok: true, message: "messages.alreadyVerified" };
  return { ok: true, message: "messages.verificationSent" };
}
