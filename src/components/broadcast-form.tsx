"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { broadcastAction } from "@/actions/checkin";
import type { ActionState } from "@/lib/validation/account";
import { Field, SubmitButton, TextAreaField } from "./form";

export function BroadcastForm({ eventId, recipientCount }: { eventId: string; recipientCount: number }) {
  const t = useTranslations("broadcast");
  const tAll = useTranslations();
  const [state, action] = useActionState(broadcastAction, {} as ActionState);
  const confirmError = state.errors?.confirm;
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.ok && (
        <p role="status" className="rounded-md bg-green-50 p-3 text-green-900">{t("sent", { count: Number(state.values?.count ?? 0) })}</p>
      )}
      {!state.ok && state.message && <p role="alert" className="rounded-md bg-red-50 p-3 text-red-900">{tAll(state.message)}</p>}
      <input type="hidden" name="eventId" value={eventId} />
      <Field name="subject" label={t("subject")} state={state.ok ? undefined : state} required />
      <TextAreaField name="body" label={t("body")} state={state.ok ? undefined : state} required rows={8} />
      <div>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="confirm" className="mt-1 h-5 w-5" aria-describedby={confirmError ? "confirm-err" : undefined} />
          <span>{t("confirm", { count: recipientCount })}</span>
        </label>
        {confirmError && <p id="confirm-err" className="mt-1 text-sm font-medium text-red-700">{t("confirmRequired")}</p>}
      </div>
      <SubmitButton>{t("send", { count: recipientCount })}</SubmitButton>
    </form>
  );
}
