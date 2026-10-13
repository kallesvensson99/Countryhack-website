"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createEventAction, saveTicketTypeAction, updateEventAction, uploadImageAction } from "@/actions/events";
import type { ActionState } from "@/lib/validation/account";
import { CheckboxField, Field, FormMessage, SubmitButton, TextAreaField } from "./form";

const initial: ActionState = {};

export interface EventDefaults {
  id?: string;
  name?: string;
  description?: string;
  venueName?: string;
  address?: string;
  startsAt?: string;
  endsAt?: string;
  registrationOpensAt?: string;
  registrationClosesAt?: string;
  seatChangeDeadline?: string;
  minAge?: string;
  showNicknamesOnMap?: boolean;
}

export function EventForm({ mode, defaults = {}, templates = [] }: { mode: "create" | "edit"; defaults?: EventDefaults; templates?: { id: string; name: string }[] }) {
  const t = useTranslations();
  const [state, action] = useActionState(mode === "create" ? createEventAction : updateEventAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <Field name="name" label={t("events.name")} state={state} required defaultValue={defaults.name} />
      <TextAreaField name="description" label={t("events.description")} state={state} required defaultValue={defaults.description} />
      <Field name="venueName" label={t("events.venueName")} state={state} required defaultValue={defaults.venueName} />
      <Field name="address" label={t("events.address")} state={state} required defaultValue={defaults.address} />
      <p className="text-sm text-slate-600">{t("events.timesHint")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="startsAt" type="datetime-local" label={t("events.startsAt")} state={state} required defaultValue={defaults.startsAt} />
        <Field name="endsAt" type="datetime-local" label={t("events.endsAt")} state={state} required defaultValue={defaults.endsAt} />
        <Field name="registrationOpensAt" type="datetime-local" label={t("events.registrationOpensAt")} state={state} required defaultValue={defaults.registrationOpensAt} />
        <Field name="registrationClosesAt" type="datetime-local" label={t("events.registrationClosesAt")} state={state} required defaultValue={defaults.registrationClosesAt} />
        <Field name="seatChangeDeadline" type="datetime-local" label={t("events.seatChangeDeadline")} state={state} optional defaultValue={defaults.seatChangeDeadline} />
        <Field name="minAge" type="number" inputMode="numeric" label={t("events.minAge")} hint={t("events.minAgeHint")} state={state} required defaultValue={defaults.minAge ?? "14"} />
      </div>
      <CheckboxField name="showNicknamesOnMap" label={t("events.showNicknamesOnMap")} hint={t("events.showNicknamesHint")} state={state} defaultChecked={defaults.showNicknamesOnMap} />
      {mode === "create" && templates.length > 0 && (
        <div>
          <label htmlFor="f-templateId" className="block text-sm font-medium">{t("events.fromTemplate")}</label>
          <select id="f-templateId" name="templateId" className="input" defaultValue="">
            <option value="">{t("events.noTemplate")}</option>
            {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
          </select>
        </div>
      )}
      <SubmitButton>{mode === "create" ? t("events.createButton") : t("common.save")}</SubmitButton>
    </form>
  );
}

export function ImageForm({ eventId }: { eventId: string }) {
  const t = useTranslations();
  const [state, action] = useActionState(uploadImageAction, initial);
  return (
    <form action={action} className="space-y-3">
      <FormMessage state={state} />
      <input type="hidden" name="id" value={eventId} />
      <div>
        <label htmlFor="f-image" className="block text-sm font-medium">{t("events.imageFile")}</label>
        <input id="f-image" name="image" type="file" accept="image/png,image/jpeg,image/webp" required className="mt-1 block w-full text-sm" aria-describedby="f-image-hint" />
        <p id="f-image-hint" className="mt-1 text-sm text-slate-600">{t("events.imageHint")}</p>
      </div>
      <SubmitButton variant="btn-secondary">{t("events.uploadImage")}</SubmitButton>
    </form>
  );
}

export interface TicketTypeDefaults {
  id?: string;
  name?: string;
  description?: string;
  price?: string;
  quantity?: string;
  salesStartsAt?: string;
  salesEndsAt?: string;
  includesSeat?: boolean;
  requiresDiscountCode?: boolean;
  hidden?: boolean;
  sortOrder?: string;
  zoneIds?: string[];
}

export function TicketTypeForm({ eventId, zones, defaults = {} }: { eventId: string; zones: { id: string; name: string; color: string }[]; defaults?: TicketTypeDefaults }) {
  const t = useTranslations();
  const [state, action] = useActionState(saveTicketTypeAction, initial);
  const uid = defaults.id ?? "new";
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="eventId" value={eventId} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <Field name="name" label={t("tickets.name")} state={state} required defaultValue={defaults.name} />
      <TextAreaField name="description" label={t("tickets.description")} state={state} rows={2} defaultValue={defaults.description} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="price" label={t("tickets.price")} hint={t("tickets.priceHint")} inputMode="numeric" state={state} required defaultValue={defaults.price} />
        <Field name="quantity" type="number" inputMode="numeric" label={t("tickets.quantity")} state={state} required defaultValue={defaults.quantity ?? "50"} />
        <Field name="salesStartsAt" type="datetime-local" label={t("tickets.salesStartsAt")} state={state} optional defaultValue={defaults.salesStartsAt} />
        <Field name="salesEndsAt" type="datetime-local" label={t("tickets.salesEndsAt")} state={state} optional defaultValue={defaults.salesEndsAt} />
        <Field name="sortOrder" type="number" inputMode="numeric" label={t("tickets.sortOrder")} state={state} defaultValue={defaults.sortOrder ?? "0"} />
      </div>
      <CheckboxField name="includesSeat" label={t("tickets.includesSeat")} state={state} defaultChecked={defaults.includesSeat ?? true} />
      <CheckboxField name="requiresDiscountCode" label={t("tickets.requiresDiscountCode")} state={state} defaultChecked={defaults.requiresDiscountCode} />
      <CheckboxField name="hidden" label={t("tickets.hidden")} hint={t("tickets.hiddenHint")} state={state} defaultChecked={defaults.hidden} />
      {zones.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("tickets.zones")}</legend>
          <p className="text-sm text-slate-600">{t("tickets.zonesHint")}</p>
          {zones.map((z) => (
            <label key={z.id} className="flex items-center gap-3 text-sm">
              <input type="checkbox" name="zoneIds" value={z.id} defaultChecked={defaults.zoneIds?.includes(z.id)} className="h-5 w-5" id={`z-${uid}-${z.id}`} />
              <span aria-hidden className="inline-block h-4 w-4 rounded-sm border border-slate-500" style={{ background: z.color }} />
              {z.name}
            </label>
          ))}
        </fieldset>
      )}
      <SubmitButton>{defaults.id ? t("common.save") : t("tickets.add")}</SubmitButton>
    </form>
  );
}
