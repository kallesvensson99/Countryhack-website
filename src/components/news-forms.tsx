"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { saveNewsAction } from "@/actions/news";
import type { ActionState } from "@/lib/validation/account";
import { CheckboxField, Field, FormMessage, SubmitButton, TextAreaField } from "./form";

const initial: ActionState = {};

export interface NewsDefaults {
  id?: string;
  title?: string;
  titleEn?: string;
  body?: string;
  bodyEn?: string;
  published?: boolean;
  /** datetime-local value in Stockholm time */
  publishedAt?: string;
  hasImage?: boolean;
}

/** Create or edit a news post (an `id` makes it an edit). */
export function NewsForm({ defaults = {} }: { defaults?: NewsDefaults }) {
  const t = useTranslations("newsManage");
  const [state, action] = useActionState(saveNewsAction, initial);
  const uid = defaults.id ?? "new";
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <Field name="title" label={t("postTitle")} state={state} required defaultValue={defaults.title} maxLength={150} />
      <TextAreaField name="body" label={t("body")} state={state} required defaultValue={defaults.body} rows={10} />
      <p className="-mt-2 text-sm text-slate-600">{t("bodyHint")}</p>
      <details className="rounded-md border-2 border-ink p-3">
        <summary className="cursor-pointer font-bold">{t("postTitleEn")} / {t("bodyEn")}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">{t("englishHint")}</p>
          <Field name="titleEn" label={t("postTitleEn")} state={state} optional defaultValue={defaults.titleEn} maxLength={150} />
          <TextAreaField name="bodyEn" label={t("bodyEn")} state={state} defaultValue={defaults.bodyEn} rows={10} />
        </div>
      </details>
      <div>
        <label htmlFor={`news-image-${uid}`} className="block text-sm font-medium">{defaults.hasImage ? t("newImage") : t("image")}</label>
        <input id={`news-image-${uid}`} name="image" type="file" accept="image/png,image/jpeg,image/webp" className="mt-1 block w-full text-sm" aria-describedby={`news-image-hint-${uid}`} />
        <p id={`news-image-hint-${uid}`} className="mt-1 text-sm text-slate-600">{t("imageHint")}</p>
      </div>
      {defaults.hasImage && <CheckboxField name="removeImage" label={t("removeImage")} state={state} />}
      <CheckboxField name="published" label={t("published")} hint={t("publishedHint")} state={state} defaultChecked={defaults.published ?? false} />
      <Field name="publishedAt" label={t("publishedAt")} hint={t("publishedAtHint")} type="datetime-local" state={state} optional defaultValue={defaults.publishedAt} />
      <SubmitButton>{defaults.id ? t("save") : t("create")}</SubmitButton>
    </form>
  );
}
