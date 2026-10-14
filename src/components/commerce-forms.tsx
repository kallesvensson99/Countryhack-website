"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { cancelOrderAction } from "@/actions/commerce";
import { saveCodeAction, saveMealAction, savePackageAction } from "@/actions/food";
import type { ActionState } from "@/lib/validation/account";
import { Field, FormMessage, SubmitButton, TextAreaField } from "./form";

const initial: ActionState = {};

export function MealForm({ eventId, meal }: { eventId: string; meal?: { id: string; name: string; servedAt: string } }) {
  const t = useTranslations("food");
  const c = useTranslations("common");
  const [state, action] = useActionState(saveMealAction, initial);
  return (
    <form action={action} className="space-y-3" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="eventId" value={eventId} />
      {meal && <input type="hidden" name="id" value={meal.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="name" label={t("mealName")} state={state} required defaultValue={meal?.name} />
        <Field name="servedAt" type="datetime-local" label={t("servedAt")} state={state} required defaultValue={meal?.servedAt} />
      </div>
      <SubmitButton>{meal ? c("save") : t("addMeal")}</SubmitButton>
    </form>
  );
}

export interface PackageDefaults {
  id?: string;
  name?: string;
  description?: string;
  price?: string;
  quantity?: string;
  salesEndsAt?: string;
  sortOrder?: string;
  variants?: string;
  mealIds?: string[];
}

export function PackageForm({ eventId, meals, defaults = {} }: { eventId: string; meals: { id: string; label: string }[]; defaults?: PackageDefaults }) {
  const t = useTranslations("food");
  const c = useTranslations("common");
  const [state, action] = useActionState(savePackageAction, initial);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="eventId" value={eventId} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <Field name="name" label={t("packageName")} state={state} required defaultValue={defaults.name} />
      <TextAreaField name="description" label={t("description")} state={state} rows={2} defaultValue={defaults.description} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="price" label={t("price")} hint={t("priceHint")} inputMode="numeric" state={state} required defaultValue={defaults.price} />
        <Field name="quantity" type="number" inputMode="numeric" label={t("quantity")} hint={t("quantityHint")} state={state} optional defaultValue={defaults.quantity} />
        <Field name="salesEndsAt" type="datetime-local" label={t("salesEndsAt")} state={state} required defaultValue={defaults.salesEndsAt} />
        <Field name="sortOrder" type="number" inputMode="numeric" label={t("sortOrder")} state={state} defaultValue={defaults.sortOrder ?? "0"} />
      </div>
      <TextAreaField name="variants" label={t("variants")} state={state} rows={3} defaultValue={defaults.variants ?? "Standard\nVegetarisk\nVegansk"} />
      <p className="-mt-2 text-sm text-slate-600">{t("variantsHint")}</p>
      {meals.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("includedMeals")}</legend>
          {meals.map((m) => (
            <label key={m.id} className="flex items-center gap-3 text-sm">
              <input type="checkbox" name="mealIds" value={m.id} defaultChecked={defaults.mealIds?.includes(m.id)} className="h-5 w-5" />
              {m.label}
            </label>
          ))}
        </fieldset>
      )}
      <SubmitButton>{defaults.id ? c("save") : t("addPackage")}</SubmitButton>
    </form>
  );
}

export interface CodeDefaults {
  id?: string;
  code?: string;
  kind?: "PERCENT" | "FIXED";
  value?: string;
  appliesTo?: "ALL" | "TICKETS" | "FOOD";
  maxUses?: string;
  validFrom?: string;
  validUntil?: string;
  ticketTypeIds?: string[];
}

export function CodeForm({ eventId, ticketTypes, defaults = {} }: { eventId: string; ticketTypes: { id: string; name: string }[]; defaults?: CodeDefaults }) {
  const t = useTranslations("codes");
  const c = useTranslations("common");
  const [state, action] = useActionState(saveCodeAction, initial);
  const sel = (name: string, label: string, options: [string, string][], value: string) => (
    <div>
      <label className="block text-sm font-medium">
        {label}
        <select name={name} className="input" defaultValue={state.values?.[name] ?? value}>
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
    </div>
  );
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="eventId" value={eventId} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <Field name="code" label={t("code")} state={state} required defaultValue={defaults.code} />
      <div className="grid gap-4 sm:grid-cols-3">
        {sel("kind", t("kind"), [["PERCENT", t("percent")], ["FIXED", t("fixed")]], defaults.kind ?? "PERCENT")}
        <Field name="value" label={t("value")} hint={t("valueHint")} inputMode="numeric" state={state} required defaultValue={defaults.value} />
        {sel("appliesTo", t("appliesTo"), [["ALL", t("all")], ["TICKETS", t("tickets")], ["FOOD", t("foodOnly")]], defaults.appliesTo ?? "ALL")}
        <Field name="maxUses" type="number" inputMode="numeric" label={t("maxUses")} state={state} optional defaultValue={defaults.maxUses} />
        <Field name="validFrom" type="datetime-local" label={t("validFrom")} state={state} optional defaultValue={defaults.validFrom} />
        <Field name="validUntil" type="datetime-local" label={t("validUntil")} state={state} optional defaultValue={defaults.validUntil} />
      </div>
      {ticketTypes.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("unlocks")}</legend>
          <p className="text-sm text-slate-600">{t("unlocksHint")}</p>
          {ticketTypes.map((tt) => (
            <label key={tt.id} className="flex items-center gap-3 text-sm">
              <input type="checkbox" name="ticketTypeIds" value={tt.id} defaultChecked={defaults.ticketTypeIds?.includes(tt.id)} className="h-5 w-5" />
              {tt.name}
            </label>
          ))}
        </fieldset>
      )}
      <SubmitButton>{defaults.id ? c("save") : t("add")}</SubmitButton>
    </form>
  );
}

/** Festivalledare: cancel a paid order — refund everything, a part, or nothing. */
export function CancelOrderForm({ orderId, totalLabel }: { orderId: string; totalLabel: string }) {
  const t = useTranslations("orders");
  const [state, action] = useActionState(cancelOrderAction, initial);
  return (
    <form action={action} className="space-y-3" noValidate onSubmit={(e) => { if (!window.confirm(t("cancelConfirm"))) e.preventDefault(); }}>
      <FormMessage state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("refund")}</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="mode" value="full" defaultChecked className="h-5 w-5" /> {t("refundFull", { total: totalLabel })}</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="mode" value="partial" className="h-5 w-5" /> {t("refundPartial")}</label>
        <Field name="amount" label={t("refundAmount")} hint={t("refundAmountHint")} inputMode="numeric" state={state} optional />
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="mode" value="none" className="h-5 w-5" /> {t("refundNone")}</label>
      </fieldset>
      <SubmitButton variant="btn-danger">{t("cancelButton")}</SubmitButton>
    </form>
  );
}

