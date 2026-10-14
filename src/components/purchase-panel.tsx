"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { checkoutAction, previewCartAction, type PreviewResponse } from "@/actions/commerce";
import { formatSek } from "@/lib/money";
import type { SeatMapData } from "@/lib/seating/types";
import { SeatMap } from "./seat-map";

export interface PanelTicketType {
  id: string;
  name: string;
  description: string;
  priceOre: number;
  includesSeat: boolean;
  zoneIds: string[];
  state: "open" | "upcoming" | "ended" | "soldOut";
  /** Pre-formatted "sales start …" text for upcoming types */
  startsLabel: string | null;
  left: number;
  needsCode: boolean;
}

export interface PanelFood {
  id: string;
  name: string;
  description: string;
  priceOre: number;
  state: "open" | "ended" | "soldOut";
  left: number | null;
  deadlineLabel: string;
  meals: { name: string; whenLabel: string }[];
  variants: { id: string; name: string }[];
  alreadyBought: boolean;
}

interface Props {
  eventId: string;
  locale: string;
  /** "buy": no ticket yet → choose ticket (+food). "food": already has a ticket → add food only. */
  mode: "buy" | "food";
  ticketTypes: PanelTicketType[];
  food: PanelFood[];
  seatMap: SeatMapData | null;
  hasUnpaid: boolean;
  flash: "cancelled" | null;
  org: { name: string; orgNumber: string | null; address: string | null };
}

export function PurchasePanel({ eventId, locale, mode, ticketTypes, food, seatMap, hasUnpaid, flash, org }: Props) {
  const t = useTranslations("checkout");
  const tAll = useTranslations();
  const money = (o: number) => formatSek(o, locale);

  const [typeId, setTypeId] = useState<string | null>(null);
  const [extraTypes, setExtraTypes] = useState<PreviewResponse["unlocked"]>([]);
  const [codeInput, setCodeInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [foodSel, setFoodSel] = useState<Record<string, string>>({});
  const [seatId, setSeatId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);

  const allTypes = useMemo(() => {
    const known = new Set(ticketTypes.map((x) => x.id));
    const unlocked: PanelTicketType[] = extraTypes
      .filter((u) => !known.has(u.id))
      .map((u) => ({ id: u.id, name: u.name, description: u.description, priceOre: u.priceOre, includesSeat: u.includesSeat, zoneIds: u.zoneIds, state: "open" as const, startsLabel: null, left: 0, needsCode: false }));
    return [...ticketTypes, ...unlocked];
  }, [ticketTypes, extraTypes]);
  const selected = allTypes.find((x) => x.id === typeId) ?? null;
  const seatsAllowed = mode === "buy" && !!selected?.includesSeat && !!seatMap;

  // Drop choices that no longer make sense (type removed with its code, seat from another zone, …)
  useEffect(() => {
    if (typeId && !allTypes.some((x) => x.id === typeId)) setTypeId(null);
  }, [allTypes, typeId]);
  useEffect(() => {
    if (!seatsAllowed) setSeatId(null);
    else if (seatId && selected && selected.zoneIds.length) {
      const seat = seatMap?.seats.find((s) => s.id === seatId);
      if (seat && !selected.zoneIds.includes(seat.zoneId)) setSeatId(null);
    }
  }, [seatsAllowed, selected, seatId, seatMap]);

  const input = useMemo(
    () => ({
      eventId,
      ticketTypeId: mode === "buy" ? typeId : null,
      seatId: seatsAllowed ? seatId : null,
      discountCode: appliedCode,
      food: Object.entries(foodSel).filter(([, v]) => v).map(([packageId, variantId]) => ({ packageId, variantId })),
    }),
    [eventId, mode, typeId, seatsAllowed, seatId, appliedCode, foodSel],
  );
  const inputKey = JSON.stringify(input);

  // live, server-validated price
  useEffect(() => {
    const mine = ++token.current;
    const h = setTimeout(async () => {
      const r = await previewCartAction(JSON.parse(inputKey));
      if (mine !== token.current) return; // a newer request superseded this one
      setPreview(r);
      setExtraTypes(r.codeApplied ? r.unlocked : []);
    }, 250);
    return () => clearTimeout(h);
  }, [inputKey]);

  const hasLines = (preview?.lines.length ?? 0) > 0;
  const codeError = preview?.error && /err_code/.test(preview.error) ? preview.error : null;
  const blockingError = preview?.error && !codeError ? preview.error : null;
  const canPay = hasLines && preview?.ok && !codeError && !busy && (mode === "food" || !!typeId);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await checkoutAction(input);
      if (r.ok) {
        window.location.assign(r.url);
        return;
      }
      setError(r.error);
    } finally {
      setBusy(false);
    }
  };

  const foodList = food.filter((f) => !f.alreadyBought);
  const anyCodeTypes = ticketTypes.some((x) => x.needsCode) || mode === "buy";

  return (
    <section aria-labelledby="buy-h" className="space-y-5 rounded-lg border-2 border-brand-500 bg-white p-5">
      <h2 id="buy-h" className="text-xl font-semibold">{mode === "buy" ? t("titleBuy") : t("titleFood")}</h2>
      {flash === "cancelled" && <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{t("cancelledNotice")}</p>}
      {hasUnpaid && <p role="note" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{t("unpaidNotice")}</p>}

      {mode === "buy" && (
        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">{t("chooseTicket")}</legend>
          {allTypes.length === 0 && <p className="text-slate-600">{t("noTickets")}</p>}
          {allTypes.map((tt) => {
            const disabled = tt.state !== "open";
            return (
              <label key={tt.id} className={`flex min-h-12 cursor-pointer items-start gap-3 rounded-md border p-3 ${typeId === tt.id ? "border-brand-600 bg-brand-50" : "border-slate-300"} ${disabled ? "opacity-60" : ""}`}>
                <input type="radio" name="ticketType" className="mt-1 h-5 w-5" value={tt.id} checked={typeId === tt.id} disabled={disabled} onChange={() => setTypeId(tt.id)} />
                <span className="grow">
                  <span className="flex flex-wrap justify-between gap-2">
                    <strong>{tt.name}</strong>
                    <strong>{money(tt.priceOre)}</strong>
                  </span>
                  {tt.description && <span className="block text-sm text-slate-700">{tt.description}</span>}
                  <span className="block text-sm text-slate-600">
                    {tt.includesSeat ? t("seatIncluded") : t("noSeat")}
                    {tt.state === "upcoming" && ` · ${tt.startsLabel}`}
                    {tt.state === "ended" && ` · ${t("salesEnded")}`}
                    {tt.state === "soldOut" && ` · ${t("soldOut")}`}
                    {tt.state === "open" && tt.left > 0 && tt.left <= 10 && ` · ${t("fewLeft", { count: tt.left })}`}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {anyCodeTypes && (
        <div className="space-y-1">
          <label htmlFor="discount-code" className="block text-sm font-medium">{t("haveCode")}</label>
          <div className="flex flex-wrap gap-2">
            <input id="discount-code" className="input mt-0 max-w-xs" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setAppliedCode(codeInput.trim() || null); } }} aria-describedby="code-status" />
            <button type="button" className="btn-secondary" onClick={() => setAppliedCode(codeInput.trim() || null)}>{t("applyCode")}</button>
            {appliedCode && <button type="button" className="btn-secondary" onClick={() => { setAppliedCode(null); setCodeInput(""); }}>{t("removeCode")}</button>}
          </div>
          <p id="code-status" role="status" className="text-sm">
            {codeError ? <span className="font-medium text-red-700">{tAll(codeError)}</span> : preview?.codeApplied ? <span className="text-green-800">{t("codeApplied", { code: preview.codeApplied })}</span> : null}
          </p>
        </div>
      )}

      {foodList.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">{t("addFood")}</legend>
          {foodList.map((f) => {
            const checked = !!foodSel[f.id];
            const disabled = f.state !== "open";
            return (
              <div key={f.id} className={`rounded-md border p-3 ${checked ? "border-brand-600 bg-brand-50" : "border-slate-300"} ${disabled ? "opacity-60" : ""}`}>
                <label className="flex min-h-11 cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-1 h-5 w-5" checked={checked} disabled={disabled} onChange={(e) => setFoodSel((s) => { const n = { ...s }; if (e.target.checked) n[f.id] = f.variants[0]?.id ?? ""; else delete n[f.id]; return n; })} />
                  <span className="grow">
                    <span className="flex flex-wrap justify-between gap-2"><strong>{f.name}</strong><strong>{money(f.priceOre)}</strong></span>
                    {f.description && <span className="block text-sm text-slate-700">{f.description}</span>}
                    {f.meals.length > 0 && <span className="block text-sm text-slate-600">{f.meals.map((m) => `${m.name} (${m.whenLabel})`).join(" · ")}</span>}
                    <span className="block text-sm text-slate-600">
                      {t("orderBy", { when: f.deadlineLabel })}
                      {f.state === "soldOut" && ` · ${t("soldOut")}`}
                      {f.state === "ended" && ` · ${t("salesEnded")}`}
                      {f.state === "open" && f.left !== null && f.left <= 10 && ` · ${t("fewLeft", { count: f.left })}`}
                    </span>
                  </span>
                </label>
                {checked && f.variants.length > 1 && (
                  <div className="mt-2 pl-8">
                    <label htmlFor={`variant-${f.id}`} className="block text-sm font-medium">{t("variant")}</label>
                    <select id={`variant-${f.id}`} className="input mt-1 max-w-xs" value={foodSel[f.id]} onChange={(e) => setFoodSel((s) => ({ ...s, [f.id]: e.target.value }))}>
                      {f.variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      {seatsAllowed && seatMap && (
        <details className="rounded-md border border-slate-300 p-3">
          <summary className="cursor-pointer font-semibold">{seatId ? t("seatChosen", { seat: seatMap.seats.find((s) => s.id === seatId)?.label ?? "" }) : t("chooseSeatOptional")}</summary>
          <div className="mt-4">
            <SeatMap data={seatMap} viewer="member" checkout={{ allowedZoneIds: selected && selected.zoneIds.length ? selected.zoneIds : null, value: seatId, onChange: setSeatId }} />
          </div>
        </details>
      )}

      <div className="space-y-2 rounded-md bg-slate-50 p-4" aria-live="polite">
        <h3 className="font-semibold">{t("summary")}</h3>
        {!hasLines ? (
          <p className="text-slate-600">{t("emptyCart")}</p>
        ) : (
          <>
            <ul className="space-y-1">
              {preview!.lines.map((l, i) => (
                <li key={i} className="flex justify-between gap-3"><span>{l.description}</span><span>{money(l.priceOre)}</span></li>
              ))}
            </ul>
            {preview!.discountOre > 0 && (
              <p className="flex justify-between gap-3 text-green-800"><span>{t("discount")}{preview!.codeApplied ? ` (${preview!.codeApplied})` : ""}</span><span>−{money(preview!.discountOre)}</span></p>
            )}
            <p className="flex justify-between gap-3 border-t border-slate-400 pt-2 text-lg font-bold"><span>{t("total")}</span><span>{money(preview!.totalOre)}</span></p>
            {preview!.totalOre === 0 && <p className="text-sm text-slate-700">{t("freeNote")}</p>}
          </>
        )}
        <p className="text-sm text-slate-700">
          {tAll("common.notVatRegistered")}
          <span className="block text-slate-600">{[org.name, org.orgNumber, org.address].filter(Boolean).join(" · ")}</span>
        </p>
      </div>

      {blockingError && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm font-medium text-red-900">{tAll(blockingError)}</p>}
      {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm font-medium text-red-900">{tAll(error)}</p>}
      <button type="button" className="btn w-full sm:w-auto" disabled={!canPay} onClick={pay}>
        {busy ? tAll("auth.submitting") : preview && preview.totalOre === 0 && hasLines ? t("completeFree") : t("pay")}
      </button>
    </section>
  );
}
