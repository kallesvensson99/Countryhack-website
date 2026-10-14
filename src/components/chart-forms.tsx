"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createChartAction, saveAsTemplateAction } from "@/actions/seating";
import type { ActionState } from "@/lib/validation/account";
import { Field, FormMessage, SubmitButton } from "./form";

const initial: ActionState = {};

/** Event without a chart yet: start empty or from a template. */
export function CreateChartForm({ eventId, templates }: { eventId: string; templates: { id: string; name: string; seats: number }[] }) {
  const t = useTranslations("editor");
  const [state, action] = useActionState(createChartAction, initial);
  return (
    <form action={action} className="space-y-4">
      <FormMessage state={state} />
      <input type="hidden" name="eventId" value={eventId} />
      <div>
        <label htmlFor="chart-template" className="block text-sm font-medium">{t("startFrom")}</label>
        <select id="chart-template" name="templateId" className="input" defaultValue="">
          <option value="">{t("blankChart")}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name} ({t("seatCount", { count: tpl.seats })})</option>
          ))}
        </select>
      </div>
      <SubmitButton>{t("createChart")}</SubmitButton>
    </form>
  );
}

export function SaveTemplateForm({ eventId, defaultName }: { eventId: string; defaultName: string }) {
  const t = useTranslations("editor");
  const [state, action] = useActionState(saveAsTemplateAction, initial);
  return (
    <form action={action} className="space-y-3">
      <FormMessage state={state} />
      <input type="hidden" name="eventId" value={eventId} />
      <Field name="name" label={t("templateName")} state={state} required defaultValue={defaultName} />
      <SubmitButton variant="btn-secondary">{t("saveAsTemplate")}</SubmitButton>
      <p className="text-sm text-slate-600">{t("saveAsTemplateHint")}</p>
    </form>
  );
}
