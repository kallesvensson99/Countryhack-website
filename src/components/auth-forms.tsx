"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { forgotPasswordAction, loginAction, registerAction, resendVerificationAction, resetPasswordAction, verifyEmailAction } from "@/actions/auth";
import { deleteAccountAction, updateProfileAction } from "@/actions/account";
import type { ActionState } from "@/lib/validation/account";
import { Field, FormMessage, SubmitButton } from "./form";

const initial: ActionState = {};

export function LoginForm({ resetDone }: { resetDone: boolean }) {
  const t = useTranslations("auth");
  const [state, action] = useActionState(loginAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      {resetDone && <p role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-900">{t("resetDone")}</p>}
      <FormMessage state={state} />
      <Field name="email" label={t("email")} type="email" state={state} required autoComplete="email" />
      <Field name="password" label={t("password")} type="password" state={state} required autoComplete="current-password" />
      <SubmitButton>{t("loginTitle")}</SubmitButton>
      <p className="text-sm">
        <Link href="/forgot-password" className="link">{t("forgotLink")}</Link>
      </p>
    </form>
  );
}

/** Profile fields shared by register + profile pages. */
export function ProfileFields({
  state,
  defaults,
  locale,
  showLocale,
}: {
  state: ActionState;
  defaults?: { realName?: string; nickname?: string; birthDate?: string; phone?: string; allergies?: string; dietaryPreferences?: string; guardianName?: string; guardianPhone?: string; locale?: string };
  locale: string;
  showLocale?: boolean;
}) {
  const t = useTranslations();
  const [birth, setBirth] = useState(defaults?.birthDate ?? "");
  const minor = isMinorClient(birth);
  return (
    <>
      <Field name="realName" label={t("auth.realName")} state={state} required defaultValue={defaults?.realName} autoComplete="name" />
      <Field name="nickname" label={t("auth.nickname")} hint={t("auth.nicknameHint")} state={state} required defaultValue={defaults?.nickname} autoComplete="nickname" />
      <div>
        <label htmlFor="f-birthDate" className="block text-sm font-medium">{t("auth.birthDate")}</label>
        <input
          id="f-birthDate"
          name="birthDate"
          type="date"
          className="input"
          required
          value={birth}
          onChange={(e) => setBirth(e.target.value)}
          autoComplete="bday"
          aria-invalid={state.errors?.birthDate ? true : undefined}
          aria-describedby={state.errors?.birthDate ? "f-birthDate-err" : undefined}
        />
        {state.errors?.birthDate && <p id="f-birthDate-err" className="mt-1 text-sm font-medium text-red-700">{t(state.errors.birthDate)}</p>}
      </div>
      <Field name="phone" label={t("auth.phone")} type="tel" inputMode="tel" state={state} required defaultValue={defaults?.phone} autoComplete="tel" />
      <Field name="allergies" label={t("auth.allergies")} state={state} optional defaultValue={defaults?.allergies} />
      <Field name="dietaryPreferences" label={t("auth.dietaryPreferences")} state={state} optional defaultValue={defaults?.dietaryPreferences} />
      {(minor || defaults?.guardianName || defaults?.guardianPhone) && (
        <fieldset className="space-y-4 rounded-md border border-slate-300 p-4">
          <legend className="px-1 text-sm font-semibold">{t("auth.guardianHint")}</legend>
          <Field name="guardianName" label={t("auth.guardianName")} state={state} required={minor} defaultValue={defaults?.guardianName} />
          <Field name="guardianPhone" label={t("auth.guardianPhone")} type="tel" inputMode="tel" state={state} required={minor} defaultValue={defaults?.guardianPhone} />
        </fieldset>
      )}
      {showLocale ? (
        <div>
          <label htmlFor="f-locale" className="block text-sm font-medium">{t("profile.language")}</label>
          <select id="f-locale" name="locale" className="input" defaultValue={state.values?.locale ?? defaults?.locale ?? locale}>
            <option value="sv">{t("profile.sv")}</option>
            <option value="en">{t("profile.en")}</option>
          </select>
        </div>
      ) : (
        <input type="hidden" name="locale" value={locale} />
      )}
    </>
  );
}

/** Rough client-side hint only; the server decides authoritatively. */
function isMinorClient(birth: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return false;
  const [y, m, d] = birth.split("-").map(Number) as [number, number, number];
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age < 18;
}

export function RegisterForm({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  const tAll = useTranslations();
  const [state, action] = useActionState(registerAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field name="email" label={t("email")} type="email" state={state} required autoComplete="email" />
      <Field name="password" label={t("password")} type="password" hint={t("passwordHint")} state={state} required autoComplete="new-password" />
      <ProfileFields state={state} locale={locale} />
      <div>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="acceptPrivacy" required defaultChecked={state.values?.acceptPrivacy === "on"} className="mt-1 h-5 w-5" aria-describedby={state.errors?.acceptPrivacy ? "f-privacy-err" : undefined} />
          <span>
            {t("acceptPrivacy")} (<Link href="/privacy" className="link" target="_blank">{t("readPrivacy")}</Link>)
          </span>
        </label>
        {state.errors?.acceptPrivacy && <p id="f-privacy-err" className="mt-1 text-sm font-medium text-red-700">{tAll(state.errors.acceptPrivacy)}</p>}
      </div>
      <SubmitButton>{t("registerTitle")}</SubmitButton>
    </form>
  );
}

export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const [state, action] = useActionState(forgotPasswordAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field name="email" label={t("email")} type="email" state={state} required autoComplete="email" />
      <SubmitButton>{t("forgotSubmit")}</SubmitButton>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("auth");
  const [state, action] = useActionState(resetPasswordAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <Field name="password" label={t("newPassword")} type="password" hint={t("passwordHint")} state={state} required autoComplete="new-password" />
      <SubmitButton>{t("resetSubmit")}</SubmitButton>
    </form>
  );
}

export function VerifyEmailForm({ token }: { token: string }) {
  const t = useTranslations("auth");
  const [state, action] = useActionState(verifyEmailAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage state={state} />
      {!state.ok && (
        <>
          <input type="hidden" name="token" value={token} />
          <SubmitButton>{t("verifySubmit")}</SubmitButton>
        </>
      )}
    </form>
  );
}

export function ResendVerificationForm() {
  const t = useTranslations("auth");
  const [state, action] = useActionState(resendVerificationAction, initial);
  return (
    <form action={action} className="space-y-3">
      <FormMessage state={state} />
      <SubmitButton variant="btn-secondary">{t("resend")}</SubmitButton>
    </form>
  );
}

export function ProfileForm({ locale, defaults }: { locale: string; defaults: React.ComponentProps<typeof ProfileFields>["defaults"] }) {
  const t = useTranslations("common");
  const [state, action] = useActionState(updateProfileAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <ProfileFields state={state} locale={locale} defaults={defaults} showLocale />
      <SubmitButton>{t("save")}</SubmitButton>
    </form>
  );
}

export function DeleteAccountForm() {
  const t = useTranslations();
  const [state, action] = useActionState(deleteAccountAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field name="password" label={t("auth.password")} type="password" state={state} required autoComplete="current-password" />
      <Field name="confirmation" label={t("profile.deleteConfirm")} state={state} required />
      <SubmitButton variant="btn-danger">{t("profile.deleteButton")}</SubmitButton>
    </form>
  );
}
