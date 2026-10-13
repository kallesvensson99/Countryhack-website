"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { setTagAction, updateOrgSettingsAction } from "@/actions/admin";
import type { ActionState } from "@/lib/validation/account";
import { Field, FormMessage, SubmitButton } from "./form";

const initial: ActionState = {};

export function TagToggle({ userId, tag, enabled, userLabel }: { userId: string; tag: "FESTIVALLEDARE" | "ADMIN"; enabled: boolean; userLabel: string }) {
  const t = useTranslations("admin");
  const [state, action] = useActionState(setTagAction, initial);
  const tAll = useTranslations();
  return (
    <form action={action} className="inline-flex flex-col gap-1">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="tag" value={tag} />
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <SubmitButton variant={enabled ? "btn-secondary" : "btn"}>
        <span className="sr-only">{userLabel}: </span>
        {enabled ? t("removeTag") : t("addTag")} {t(`tag_${tag}`)}
      </SubmitButton>
      {state.message && (
        <span role={state.ok ? "status" : "alert"} className={`text-sm ${state.ok ? "text-green-800" : "text-red-700"}`}>
          {tAll(state.message)}
        </span>
      )}
    </form>
  );
}

export function OrgSettingsForm({
  defaults,
}: {
  defaults: { name: string; orgNumber: string; address: string; contactEmail: string; privacyPolicyVersion: string };
}) {
  const t = useTranslations("admin");
  const c = useTranslations("common");
  const [state, action] = useActionState(updateOrgSettingsAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field name="name" label={t("orgName")} state={state} required defaultValue={defaults.name} />
      <Field name="orgNumber" label={t("orgNumber")} state={state} optional defaultValue={defaults.orgNumber} />
      <Field name="address" label={t("orgAddress")} state={state} optional defaultValue={defaults.address} />
      <Field name="contactEmail" label={t("contactEmail")} type="email" state={state} optional defaultValue={defaults.contactEmail} />
      <Field name="privacyPolicyVersion" label={t("privacyVersion")} hint={t("privacyVersionHint")} state={state} required defaultValue={defaults.privacyPolicyVersion} />
      <SubmitButton>{c("save")}</SubmitButton>
    </form>
  );
}
