"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createTeamAction, inviteMemberAction, updateTeamAction } from "@/actions/teams";
import type { ActionState } from "@/lib/validation/account";
import { Field, FormMessage, SubmitButton, TextAreaField } from "./form";

const initial: ActionState = {};

export interface TeamDefaults {
  id?: string;
  name?: string;
  tag?: string;
  description?: string;
}

/** Create a team (you become its captain) or edit one (an `id` makes it an edit). */
export function TeamForm({ defaults = {} }: { defaults?: TeamDefaults }) {
  const t = useTranslations("teams");
  const [state, action] = useActionState(defaults.id ? updateTeamAction : createTeamAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
        <Field name="name" label={t("name")} hint={t("nameHint")} state={state} required defaultValue={defaults.name} maxLength={40} />
        <Field name="tag" label={t("tag")} hint={t("tagHint")} state={state} optional defaultValue={defaults.tag} maxLength={5} />
      </div>
      <TextAreaField name="description" label={t("description")} state={state} defaultValue={defaults.description} rows={3} />
      <SubmitButton>{defaults.id ? t("save") : t("create")}</SubmitButton>
    </form>
  );
}

/** The captain invites someone by nickname. */
export function InviteForm({ teamId }: { teamId: string }) {
  const t = useTranslations("teams");
  const [state, action] = useActionState(inviteMemberAction, initial);
  return (
    <form action={action} className="space-y-3" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="teamId" value={teamId} />
      <Field name="nickname" label={t("inviteNickname")} hint={t("inviteHint")} state={state} required maxLength={30} />
      <SubmitButton>{t("invite")}</SubmitButton>
    </form>
  );
}
