"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/validation/account";

export function SubmitButton({ children, variant = "btn" }: { children: React.ReactNode; variant?: "btn" | "btn-danger" | "btn-secondary" }) {
  const { pending } = useFormStatus();
  const t = useTranslations("auth");
  return (
    <button type="submit" className={variant} disabled={pending} aria-disabled={pending}>
      {pending ? t("submitting") : children}
    </button>
  );
}

interface FieldProps {
  name: string;
  label: string;
  type?: string;
  state?: ActionState;
  hint?: string;
  required?: boolean;
  optional?: boolean;
  defaultValue?: string;
  autoComplete?: string;
  inputMode?: "text" | "tel" | "email" | "numeric";
  maxLength?: number;
}

export function Field({ name, label, type = "text", state, hint, required, optional, defaultValue, autoComplete, inputMode, maxLength }: FieldProps) {
  const t = useTranslations();
  const errorKey = state?.errors?.[name];
  const uid = useId();
  const id = `${uid}-${name}`;
  const describedBy = [hint ? `${id}-hint` : null, errorKey ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {optional && <span className="ml-1 font-normal text-slate-600">({t("common.optional")})</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        className="input"
        required={required}
        defaultValue={state?.values?.[name] ?? defaultValue}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-invalid={errorKey ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-sm text-slate-600">
          {hint}
        </p>
      )}
      {errorKey && (
        <p id={`${id}-err`} className="mt-1 text-sm font-medium text-red-700">
          {t(errorKey)}
        </p>
      )}
    </div>
  );
}

/** Status line for the whole form. role=alert so screen readers announce it. */
export function FormMessage({ state }: { state: ActionState }) {
  const t = useTranslations();
  const key = state.message ?? state.errors?._;
  if (!key) return null;
  return (
    <p role={state.ok ? "status" : "alert"} className={`rounded-md p-3 text-sm ${state.ok ? "bg-green-50 text-green-900" : "bg-red-50 text-red-900"}`}>
      {t(key)}
    </p>
  );
}

export function TextAreaField({ name, label, state, required, defaultValue, rows = 5 }: { name: string; label: string; state?: ActionState; required?: boolean; defaultValue?: string; rows?: number }) {
  const t = useTranslations();
  const errorKey = state?.errors?.[name];
  const uid = useId();
  const id = `${uid}-${name}`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        required={required}
        className="input"
        defaultValue={state?.values?.[name] ?? defaultValue}
        aria-invalid={errorKey ? true : undefined}
        aria-describedby={errorKey ? `${id}-err` : undefined}
      />
      {errorKey && <p id={`${id}-err`} className="mt-1 text-sm font-medium text-red-700">{t(errorKey)}</p>}
    </div>
  );
}

export function CheckboxField({ name, label, state, defaultChecked, hint }: { name: string; label: string; state?: ActionState; defaultChecked?: boolean; hint?: string }) {
  const checked = state?.values ? state.values[name] === "on" : defaultChecked;
  return (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-1 h-5 w-5" />
      <span>
        {label}
        {hint && <span className="block text-slate-600">{hint}</span>}
      </span>
    </label>
  );
}

/** A one-button form for actions like publish / duplicate / delete, with an optional confirm prompt. */
export function ActionButton({
  action,
  fields,
  label,
  variant = "btn-secondary",
  confirm,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  label: string;
  variant?: "btn" | "btn-secondary" | "btn-danger";
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const t = useTranslations();
  return (
    <form action={formAction} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }} className="inline-flex flex-col gap-1">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <SubmitButton variant={variant}>{label}</SubmitButton>
      {state.message && <span role={state.ok ? "status" : "alert"} className={`text-sm ${state.ok ? "text-green-800" : "text-red-700"}`}>{t(state.message)}</span>}
    </form>
  );
}
