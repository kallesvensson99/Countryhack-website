"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { saveScheduleCategoryAction, saveScheduleItemAction } from "@/actions/schedule";
import { SCHEDULE_COLORS, type ScheduleColor } from "@/lib/schedule/palette";
import type { ActionState } from "@/lib/validation/account";
import { Field, FormMessage, SubmitButton, TextAreaField } from "./form";

const initial: ActionState = {};

export interface CategoryDefaults {
  id?: string;
  name?: string;
  nameEn?: string;
  color?: string;
}

/** Create or edit a category: a name and one colour from the fixed palette. */
export function ScheduleCategoryForm({ eventId, defaults = {} }: { eventId: string; defaults?: CategoryDefaults }) {
  const t = useTranslations("scheduleManage");
  const tc = useTranslations("schedule");
  const tAll = useTranslations();
  const [state, action] = useActionState(saveScheduleCategoryAction, initial);
  const uid = defaults.id ?? "new";
  const chosen = state.values?.color ?? defaults.color ?? "hay";
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="eventId" value={eventId} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label={t("categoryName")} state={state} required defaultValue={defaults.name} maxLength={60} />
        <Field name="nameEn" label={t("categoryNameEn")} state={state} optional defaultValue={defaults.nameEn} maxLength={60} />
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("color")}</legend>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SCHEDULE_COLORS) as ScheduleColor[]).map((key) => (
            <label key={key} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border-2 border-ink bg-card px-3 py-1 text-sm font-bold has-[:checked]:bg-hay has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-barn">
              <input type="radio" name="color" value={key} defaultChecked={chosen === key} id={`cat-${uid}-${key}`} className="sr-only" />
              <span aria-hidden className="h-5 w-5 rounded border-2 border-ink" style={{ background: SCHEDULE_COLORS[key].bg }} />
              {tc(`color_${key}`)}
            </label>
          ))}
        </div>
        {state.errors?.color && <p role="alert" className="mt-1 text-sm font-medium text-barn">{tAll(state.errors.color)}</p>}
      </fieldset>
      <SubmitButton>{defaults.id ? t("saveCategory") : t("addCategory")}</SubmitButton>
    </form>
  );
}

export interface ItemDefaults {
  id?: string;
  title?: string;
  titleEn?: string;
  description?: string;
  descriptionEn?: string;
  location?: string;
  categoryId?: string;
  /** datetime-local values, Stockholm time */
  startsAt?: string;
  endsAt?: string;
}

/** Create or edit one block of the programme. */
export function ScheduleItemForm({ eventId, categories, defaults = {}, defaultStart }: { eventId: string; categories: { id: string; label: string }[]; defaults?: ItemDefaults; defaultStart?: string }) {
  const t = useTranslations("scheduleManage");
  const [state, action] = useActionState(saveScheduleItemAction, initial);
  const uid = defaults.id ?? "new";
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="eventId" value={eventId} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <Field name="title" label={t("itemTitle")} state={state} required defaultValue={defaults.title} maxLength={100} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="startsAt" label={t("startsAt")} type="datetime-local" state={state} required defaultValue={defaults.startsAt ?? defaultStart} />
        <Field name="endsAt" label={t("endsAt")} type="datetime-local" state={state} required defaultValue={defaults.endsAt} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`item-cat-${uid}`} className="block text-sm font-medium">{t("category")}</label>
          <select id={`item-cat-${uid}`} name="categoryId" className="input" defaultValue={state.values?.categoryId ?? defaults.categoryId ?? ""}>
            <option value="">{t("noCategory")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
        <Field name="location" label={t("location")} state={state} optional defaultValue={defaults.location} maxLength={100} />
      </div>
      <TextAreaField name="description" label={t("description")} state={state} defaultValue={defaults.description} rows={3} />
      <details className="rounded-md border-2 border-ink p-3">
        <summary className="cursor-pointer font-bold">{t("itemTitleEn")} / {t("descriptionEn")}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">{t("englishHint")}</p>
          <Field name="titleEn" label={t("itemTitleEn")} state={state} optional defaultValue={defaults.titleEn} maxLength={100} />
          <TextAreaField name="descriptionEn" label={t("descriptionEn")} state={state} defaultValue={defaults.descriptionEn} rows={3} />
        </div>
      </details>
      <SubmitButton>{defaults.id ? t("saveItem") : t("addItem")}</SubmitButton>
    </form>
  );
}
