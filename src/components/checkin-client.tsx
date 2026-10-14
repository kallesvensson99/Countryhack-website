"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useFormatter, useTranslations } from "next-intl";
import { checkInAction, collectMealAction, openCardAction, scanAction, searchAction, undoCheckInAction, type CardResponse } from "@/actions/checkin";
import type { AttendeeCard, SearchHit } from "@/lib/checkin/service";

type Notice = { kind: "ok" | "warn" | "error"; text: string } | null;

/**
 * Door tool. Mobile first: big tap targets, one card at a time.
 * Camera scanning uses @zxing/browser (needs HTTPS, or localhost); search and pasted codes work everywhere.
 */
export function CheckinClient({ eventId }: { eventId: string }) {
  const t = useTranslations("checkin");
  const tAll = useTranslations();
  const f = useFormatter();

  const [card, setCard] = useState<AttendeeCard | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const lastScan = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const show = useCallback((r: CardResponse, okText?: string) => {
    if (r.ok) {
      setCard(r.card);
      setNotice(r.notice === "alreadyCheckedIn" ? { kind: "warn", text: "checkin.alreadyCheckedIn" } : okText ? { kind: "ok", text: okText } : null);
    } else {
      setCard(null);
      setNotice({ kind: "error", text: r.error });
    }
  }, []);

  const stopCamera = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setScanning(false);
  }, []);

  const handleToken = useCallback(
    async (text: string) => {
      const now = Date.now();
      if (lastScan.current.text === text && now - lastScan.current.at < 3000) return; // same code still in view
      lastScan.current = { text, at: now };
      setBusy(true);
      try {
        show(await scanAction(eventId, text));
        setHits(null);
        setQuery("");
      } finally {
        setBusy(false);
      }
    },
    [eventId, show],
  );

  const startCamera = useCallback(async () => {
    setCameraError(null);
    setCard(null);
    setNotice(null);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("insecure");
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 150 });
      flushSync(() => setScanning(true)); // the <video> must be visible before the stream attaches
      const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current!, (result, _error, ctl) => {
        if (!result) return;
        ctl.stop(); // one code at a time: stop, show the card, restart with "Scan next"
        stopRef.current = null;
        setScanning(false);
        void handleToken(result.getText());
      });
      stopRef.current = () => controls.stop();
    } catch (e) {
      setScanning(false);
      const name = e instanceof Error ? e.name : "";
      setCameraError(name === "NotAllowedError" ? "checkin.cameraDenied" : e instanceof Error && e.message === "insecure" ? "checkin.cameraInsecure" : "checkin.cameraFailed");
    }
  }, [handleToken]);

  useEffect(() => () => stopRef.current?.(), []);

  const submitQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    stopCamera();
    setBusy(true);
    try {
      if (q.startsWith("ccss1.")) {
        await handleToken(q);
      } else {
        const found = await searchAction(eventId, q);
        setHits(found);
        setCard(null);
        setNotice(found.length === 0 ? { kind: "warn", text: "checkin.noHits" } : null);
      }
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<CardResponse>, okText?: string) => {
    setBusy(true);
    try {
      show(await fn(), okText);
    } finally {
      setBusy(false);
    }
  };

  const time = (iso: string) => f.dateTime(new Date(iso), { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <section aria-labelledby="scan-h" className="space-y-3">
        <h2 id="scan-h" className="sr-only">{t("scan")}</h2>
        {/* one <video> that is always mounted, so the camera stream survives re-renders */}
        <video ref={videoRef} className={scanning ? "aspect-square w-full rounded-lg bg-black object-cover" : "hidden"} muted playsInline aria-label={t("cameraLabel")} />
        {scanning ? (
          <button type="button" className="btn-secondary w-full" onClick={stopCamera}>{t("stopCamera")}</button>
        ) : (
          <button type="button" className="btn min-h-14 w-full text-lg" onClick={startCamera} disabled={busy}>{card ? t("scanNext") : t("startCamera")}</button>
        )}
        {cameraError && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-900">{tAll(cameraError)}</p>}
      </section>

      <form onSubmit={submitQuery} role="search" className="space-y-2">
        <label htmlFor="checkin-q" className="block text-sm font-medium">{t("searchLabel")}</label>
        <div className="flex gap-2">
          <input id="checkin-q" className="input mt-0 min-h-12" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" autoCapitalize="none" enterKeyHint="search" />
          <button type="submit" className="btn min-h-12 px-5" disabled={busy}>{t("search")}</button>
        </div>
        <p className="text-sm text-slate-600">{t("searchHint")}</p>
      </form>

      {notice && (
        <p role={notice.kind === "error" ? "alert" : "status"} className={`rounded-md border p-3 font-medium ${notice.kind === "ok" ? "border-green-400 bg-green-50 text-green-900" : notice.kind === "warn" ? "border-amber-400 bg-amber-50 text-amber-900" : "border-red-400 bg-red-50 text-red-900"}`}>
          {tAll(notice.text)}
        </p>
      )}

      {hits && hits.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-300 bg-white" aria-label={t("results")}>
          {hits.map((h) => (
            <li key={h.ticketId}>
              <button type="button" className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-slate-50" onClick={() => run(() => openCardAction(eventId, h.ticketId))}>
                <span>
                  <strong>{h.nickname}</strong> <span className="text-slate-700">{h.realName}</span>
                  <span className="block text-sm text-slate-600">{h.ticketType} · {h.orderNumber}</span>
                </span>
                {h.checkedIn && <span className="rounded bg-green-100 px-2 py-1 text-sm text-green-900">{t("checkedInBadge")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {card && (
        <article aria-label={`${card.nickname}`} className="space-y-4 rounded-lg border-2 border-slate-400 bg-white p-4">
          <header>
            <h2 className="text-2xl font-bold">{card.realName}</h2>
            <p className="text-lg text-slate-700">{card.nickname}</p>
            <p className="text-sm text-slate-600">{card.ticketType} · {t("seat")}: <strong>{card.seat ?? t("noSeat")}</strong> · {card.orderNumber}</p>
            <p className="text-sm text-slate-600"><a className="link" href={`tel:${card.phone.replace(/\s/g, "")}`}>{card.phone}</a></p>
          </header>

          {card.minor && (
            <div role="alert" className="rounded-md border-2 border-red-500 bg-red-50 p-3 text-red-900">
              <p className="font-bold">{t("minor")}</p>
              <p>{t("guardian")}: <strong>{card.minor.guardianName ?? t("missing")}</strong></p>
              {card.minor.guardianPhone ? <a className="link text-lg font-bold" href={`tel:${card.minor.guardianPhone.replace(/\s/g, "")}`}>{card.minor.guardianPhone}</a> : <p>{t("guardianPhone")}: {t("missing")}</p>}
            </div>
          )}

          {(card.allergies || card.dietary) && (
            <div className="rounded-md border-2 border-amber-500 bg-amber-50 p-3 text-amber-950">
              {card.allergies && <p><strong>{t("allergies")}:</strong> {card.allergies}</p>}
              {card.dietary && <p><strong>{t("dietary")}:</strong> {card.dietary}</p>}
            </div>
          )}

          {card.food.length > 0 && (
            <section aria-label={t("food")} className="space-y-3">
              <h3 className="font-semibold">{t("food")}</h3>
              {card.food.map((fp) => (
                <div key={fp.purchaseId} className="rounded-md border border-slate-300 p-3">
                  <p className="font-medium">{fp.packageName} – {fp.variantName}</p>
                  <ul className="mt-2 space-y-2">
                    {fp.meals.map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-3">
                        <span>
                          {m.name}
                          <span className="block text-sm text-slate-600">{f.dateTime(new Date(m.servedAt), { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
                        </span>
                        {m.collected ? (
                          <button type="button" className="btn-secondary min-h-12" onClick={() => run(() => collectMealAction(eventId, fp.purchaseId, m.id, false))} disabled={busy} aria-label={t("undoCollect", { meal: m.name })}>
                            ✓ {t("collected", { by: m.collected.by })}
                          </button>
                        ) : (
                          <button type="button" className="btn min-h-12" onClick={() => run(() => collectMealAction(eventId, fp.purchaseId, m.id, true))} disabled={busy} aria-label={t("collectMeal", { meal: m.name })}>
                            {t("collect")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {!card.checkedIn && <p className="text-sm text-amber-800">{t("notCheckedInFood")}</p>}
            </section>
          )}

          {card.checkedIn ? (
            <div className="space-y-2">
              <p className="rounded-md bg-green-100 p-3 text-center text-lg font-bold text-green-900">
                ✓ {t("checkedInAt", { when: time(card.checkedIn.at), by: card.checkedIn.by })}
              </p>
              <button type="button" className="btn-secondary w-full" onClick={() => { if (window.confirm(t("undoConfirm"))) void run(() => undoCheckInAction(eventId, card.ticketId)); }} disabled={busy}>{t("undo")}</button>
            </div>
          ) : (
            <button type="button" className="btn min-h-16 w-full text-xl" onClick={() => run(() => checkInAction(eventId, card.ticketId), "checkin.checkedInOk")} disabled={busy}>
              {busy ? tAll("auth.submitting") : t("checkIn")}
            </button>
          )}
        </article>
      )}
    </div>
  );
}
