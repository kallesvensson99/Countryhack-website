"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { applyCrewAction, setApplicationStatusAction, saveCrewJobAction, withdrawCrewAction } from "@/actions/crew";
import { moveFaqAction, saveFaqAction } from "@/actions/faq";
import type { ActionState } from "@/lib/validation/account";
import { CheckboxField, Field, FormMessage, SubmitButton, TextAreaField } from "./form";

const initial: ActionState = {};

export interface JobDefaults {
  id?: string;
  title?: string;
  description?: string;
  titleEn?: string;
  descriptionEn?: string;
  before?: boolean;
  during?: boolean;
  after?: boolean;
  spots?: string;
  isOpen?: boolean;
}

/** Create or edit a crew job (an `id` makes it an edit). */
export function CrewJobForm({ defaults = {} }: { defaults?: JobDefaults }) {
  const t = useTranslations("crewManage");
  const tc = useTranslations("crew");
  const [state, action] = useActionState(saveCrewJobAction, initial);
  const tAll = useTranslations();
  const whenError = state.errors?.during;
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <Field name="title" label={t("jobTitle")} state={state} required defaultValue={defaults.title} maxLength={100} />
      <TextAreaField name="description" label={t("description")} state={state} required defaultValue={defaults.description} rows={4} />
      <details className="rounded-md border-2 border-ink p-3">
        <summary className="cursor-pointer font-bold">{t("jobTitleEn")} / {t("descriptionEn")}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">{t("englishHint")}</p>
          <Field name="titleEn" label={t("jobTitleEn")} state={state} optional defaultValue={defaults.titleEn} maxLength={100} />
          <TextAreaField name="descriptionEn" label={t("descriptionEn")} state={state} defaultValue={defaults.descriptionEn} rows={4} />
        </div>
      </details>
      <fieldset className="space-y-2" aria-describedby={whenError ? "when-err" : undefined}>
        <legend className="font-medium">{t("when")}</legend>
        <CheckboxField name="before" label={tc("when_before")} state={state} defaultChecked={defaults.before ?? false} />
        <CheckboxField name="during" label={tc("when_during")} state={state} defaultChecked={defaults.during ?? true} />
        <CheckboxField name="after" label={tc("when_after")} state={state} defaultChecked={defaults.after ?? false} />
        {whenError && <p id="when-err" role="alert" className="text-sm font-medium text-barn">{tAll(whenError)}</p>}
      </fieldset>
      <Field name="spots" label={t("spots")} hint={t("spotsHint")} state={state} optional defaultValue={defaults.spots} inputMode="numeric" maxLength={4} />
      <CheckboxField name="isOpen" label={t("isOpen")} state={state} defaultChecked={defaults.isOpen ?? true} />
      <SubmitButton>{defaults.id ? t("save") : t("create")}</SubmitButton>
    </form>
  );
}

/** Accept / decline / reset buttons for one application. */
export function ApplicationStatus({ id, status, label }: { id: string; status: "NEW" | "ACCEPTED" | "DECLINED"; label: string }) {
  const t = useTranslations("crewManage");
  const tAll = useTranslations();
  const [state, action] = useActionState(setApplicationStatusAction, initial);
  const targets = (["ACCEPTED", "DECLINED", "NEW"] as const).filter((s) => s !== status);
  const text = { ACCEPTED: t("accept"), DECLINED: t("decline"), NEW: t("reset") };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {targets.map((s) => (
        <form key={s} action={action}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value={s} />
          <button type="submit" className={s === "ACCEPTED" ? "btn min-h-11" : "btn-secondary min-h-11"}>
            <span className="sr-only">{label}: </span>
            {text[s]}
          </button>
        </form>
      ))}
      {state.message && <span role={state.ok ? "status" : "alert"} className="text-sm">{tAll(state.message)}</span>}
    </div>
  );
}

export function ApplyForm({ jobs, defaultJobId }: { jobs: { id: string; title: string }[]; defaultJobId?: string }) {
  const t = useTranslations("crew");
  const tAll = useTranslations();
  const [state, action] = useActionState(applyCrewAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <div>
        <label htmlFor="apply-job" className="block text-sm font-medium">{t("formJob")}</label>
        <select id="apply-job" name="jobId" className="input" defaultValue={state.values?.jobId ?? defaultJobId ?? jobs[0]?.id}>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>{j.title}</option>
          ))}
        </select>
      </div>
      <TextAreaField name="message" label={t("formMessage")} state={state} required rows={5} defaultValue="" />
      <p className="-mt-2 text-sm text-slate-600">{t("formMessageHint")}</p>
      <Field name="availability" label={t("formAvailability")} hint={t("formAvailabilityHint")} state={state} required maxLength={300} />
      {state.errors?.jobId && <p role="alert" className="text-sm font-medium text-barn">{tAll(state.errors.jobId)}</p>}
      <SubmitButton>{t("formSubmit")}</SubmitButton>
    </form>
  );
}

export function WithdrawButton({ jobId }: { jobId: string }) {
  const t = useTranslations("crew");
  const tAll = useTranslations();
  const [state, action] = useActionState(withdrawCrewAction, initial);
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm(t("withdrawConfirm"))) e.preventDefault(); }} className="inline-flex flex-col gap-1">
      <input type="hidden" name="jobId" value={jobId} />
      <SubmitButton variant="btn-secondary">{t("withdraw")}</SubmitButton>
      {state.message && <span role={state.ok ? "status" : "alert"} className="text-sm">{tAll(state.message)}</span>}
    </form>
  );
}

export interface FaqDefaults {
  id?: string;
  group?: string;
  questionSv?: string;
  answerSv?: string;
  questionEn?: string;
  answerEn?: string;
}

export function FaqForm({ groups, defaults = {} }: { groups: { value: string; label: string }[]; defaults?: FaqDefaults }) {
  const t = useTranslations("faqManage");
  const [state, action] = useActionState(saveFaqAction, initial);
  const uid = defaults.id ?? "new";
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <div>
        <label htmlFor={`faq-group-${uid}`} className="block text-sm font-medium">{t("group")}</label>
        <select id={`faq-group-${uid}`} name="group" className="input" defaultValue={state.values?.group ?? defaults.group ?? groups[0]?.value}>
          {groups.map((g) => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </select>
      </div>
      <Field name="questionSv" label={t("questionSv")} state={state} required defaultValue={defaults.questionSv} maxLength={300} />
      <TextAreaField name="answerSv" label={t("answerSv")} state={state} required defaultValue={defaults.answerSv} rows={5} />
      <p className="-mt-2 text-sm text-slate-600">{t("placeholders")}</p>
      <details className="rounded-md border-2 border-ink p-3">
        <summary className="cursor-pointer font-bold">{t("questionEn")} / {t("answerEn")}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">{t("englishHint")}</p>
          <Field name="questionEn" label={t("questionEn")} state={state} optional defaultValue={defaults.questionEn} maxLength={300} />
          <TextAreaField name="answerEn" label={t("answerEn")} state={state} defaultValue={defaults.answerEn} rows={5} />
        </div>
      </details>
      <SubmitButton>{defaults.id ? t("save") : t("create")}</SubmitButton>
    </form>
  );
}

export function MoveFaq({ id, direction, label, disabled }: { id: string; direction: "up" | "down"; label: string; disabled: boolean }) {
  const [, action] = useActionState(moveFaqAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="direction" value={direction} />
      <button type="submit" className="btn-secondary min-h-11 min-w-11 px-3" disabled={disabled} aria-label={label}>
        <span aria-hidden>{direction === "up" ? "↑" : "↓"}</span>
      </button>
    </form>
  );
}
