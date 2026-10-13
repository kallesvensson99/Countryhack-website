"use client";

import { useTranslations } from "next-intl";
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
  const id = `f-${name}`;
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
