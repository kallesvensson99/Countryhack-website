"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { saveAboutIntroAction, saveBoardMemberAction, saveDocumentAction } from "@/actions/association";
import type { ActionState } from "@/lib/validation/account";
import { Field, FormMessage, SubmitButton, TextAreaField } from "./form";

const initial: ActionState = {};

export function AboutIntroForm({ defaults }: { defaults: { sv: string; en: string } }) {
  const t = useTranslations("associationManage");
  const [state, action] = useActionState(saveAboutIntroAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <TextAreaField name="aboutIntroSv" label={t("introSv")} state={state} defaultValue={defaults.sv} rows={8} />
      <details className="rounded-md border-2 border-ink p-3">
        <summary className="cursor-pointer font-bold">{t("introEn")}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">{t("englishHint")}</p>
          <TextAreaField name="aboutIntroEn" label={t("introEn")} state={state} defaultValue={defaults.en} rows={8} />
        </div>
      </details>
      <p className="text-sm text-slate-600">{t("introHint")}</p>
      <SubmitButton>{t("saveIntro")}</SubmitButton>
    </form>
  );
}

export interface BoardDefaults {
  id?: string;
  name?: string;
  role?: string;
  roleEn?: string;
  email?: string;
  sortOrder?: string;
}

export function BoardMemberForm({ defaults = {} }: { defaults?: BoardDefaults }) {
  const t = useTranslations("associationManage");
  const [state, action] = useActionState(saveBoardMemberAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label={t("memberName")} state={state} required defaultValue={defaults.name} maxLength={100} />
        <Field name="role" label={t("memberRole")} hint={t("memberRoleHint")} state={state} required defaultValue={defaults.role} maxLength={100} />
        <Field name="roleEn" label={t("memberRoleEn")} state={state} optional defaultValue={defaults.roleEn} maxLength={100} />
        <Field name="email" label={t("memberEmail")} hint={t("memberEmailHint")} type="email" state={state} optional defaultValue={defaults.email} maxLength={254} />
      </div>
      <Field name="sortOrder" label={t("sortOrder")} hint={t("sortOrderHint")} state={state} defaultValue={defaults.sortOrder ?? "0"} inputMode="numeric" maxLength={4} />
      <SubmitButton>{defaults.id ? t("saveMember") : t("addMember")}</SubmitButton>
    </form>
  );
}

export interface DocDefaults {
  id?: string;
  title?: string;
  category?: string;
  docDate?: string;
  visibility?: string;
}

/** Upload (file required) or edit the details of (an `id`) a document. */
export function DocumentForm({ categories, visibilities, defaults = {} }: { categories: { value: string; label: string }[]; visibilities: { value: string; label: string }[]; defaults?: DocDefaults }) {
  const t = useTranslations("associationManage");
  const [state, action] = useActionState(saveDocumentAction, initial);
  const uid = defaults.id ?? "new";
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <Field name="title" label={t("docTitle")} state={state} required defaultValue={defaults.title} maxLength={150} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`doc-cat-${uid}`} className="block text-sm font-medium">{t("docCategory")}</label>
          <select id={`doc-cat-${uid}`} name="category" className="input" defaultValue={state.values?.category ?? defaults.category ?? "MINUTES"}>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <Field name="docDate" label={t("docDate")} hint={t("docDateHint")} type="date" state={state} optional defaultValue={defaults.docDate} />
      </div>
      <div>
        <label htmlFor={`doc-vis-${uid}`} className="block text-sm font-medium">{t("docVisibility")}</label>
        <select id={`doc-vis-${uid}`} name="visibility" className="input" defaultValue={state.values?.visibility ?? defaults.visibility ?? "LOGGED_IN"} aria-describedby={`doc-vis-hint-${uid}`}>
          {visibilities.map((v) => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>
        <p id={`doc-vis-hint-${uid}`} className="mt-1 text-sm text-slate-600">{t("docVisibilityHint")}</p>
      </div>
      {!defaults.id && (
        <div>
          <label htmlFor="doc-file-new" className="block text-sm font-medium">{t("docFile")}</label>
          <input id="doc-file-new" name="file" type="file" required accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp" className="mt-1 block w-full text-sm" aria-describedby="doc-file-hint" />
          <p id="doc-file-hint" className="mt-1 text-sm text-slate-600">{t("docFileHint")}</p>
        </div>
      )}
      <SubmitButton>{defaults.id ? t("saveDoc") : t("uploadDoc")}</SubmitButton>
    </form>
  );
}
