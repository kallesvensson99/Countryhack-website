"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { chooseSeatAction } from "@/actions/seating";
import type { MapSeat, SeatMapData } from "@/lib/seating/types";
import { LegendItem, ObjectShape, SeatDefs, SeatShape } from "./seat-glyph";

type Viewer = "visitor" | "member";

const MIN_K = 1;
const MAX_K = 6;

/** In checkout mode the buyer picks a seat for a ticket they're about to buy: nothing is saved here, the parent holds the choice. */
export interface CheckoutPick {
  /** Zones the chosen ticket type may use (null = all). */
  allowedZoneIds: string[] | null;
  value: string | null;
  onChange: (seatId: string | null) => void;
}

export function SeatMap({ data: rawData, viewer, ticketLabel, checkout }: { data: SeatMapData; viewer: Viewer; ticketLabel?: string; checkout?: CheckoutPick }) {
  const t = useTranslations("seats");
  const tAll = useTranslations();
  const router = useRouter();
  // In checkout mode "selectable" depends on the ticket type being bought, so it's recomputed here.
  const data = useMemo<SeatMapData>(
    () => (checkout ? { ...rawData, seats: rawData.seats.map((s) => ({ ...s, selectable: s.state === "free" && (!checkout.allowedZoneIds || checkout.allowedZoneIds.includes(s.zoneId)) })) } : rawData),
    [rawData, checkout],
  );
  const zoneById = useMemo(() => new Map(data.zones.map((z) => [z.id, z])), [data.zones]);
  const kindLabels = useMemo(() => Object.fromEntries(["TABLE", "STAGE", "ENTRANCE", "KITCHEN", "TOILET", "WALL", "LABEL"].map((k) => [k, t(`kind_${k}`)])), [t]);

  const [view, setView] = useState<"map" | "list">("map");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selectedId = checkout ? checkout.value : localSelected;
  const setSelectedId = (id: string | null) => (checkout ? checkout.onChange(id) : setLocalSelected(id));
  const [activeId, setActiveId] = useState<string | null>(null); // hovered / focused
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // list filters
  const [zoneFilter, setZoneFilter] = useState("");
  const [onlyFree, setOnlyFree] = useState(false);

  // ---- pan / zoom (viewBox based)
  const W = data.chart.width;
  const H = data.chart.height;
  const [cam, setCam] = useState({ k: 1, cx: W / 2, cy: H / 2 });
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startCam: typeof cam; startPt?: { x: number; y: number }; startDist?: number; moved: boolean } | null>(null);
  const moved = useRef(false);

  const clampCam = useCallback(
    (c: { k: number; cx: number; cy: number }) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, c.k));
      return { k, cx: Math.min(W, Math.max(0, c.cx)), cy: Math.min(H, Math.max(0, c.cy)) };
    },
    [W, H],
  );
  const zoomBy = (factor: number) => setCam((c) => clampCam({ ...c, k: c.k * factor }));
  const resetCam = () => setCam({ k: 1, cx: W / 2, cy: H / 2 });

  // wheel zoom around the cursor (needs a non-passive listener to stop page scroll)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setCam((c) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, c.k * Math.exp(-e.deltaY * 0.0015)));
        const fx = (e.clientX - rect.left) / rect.width - 0.5;
        const fy = (e.clientY - rect.top) / rect.height - 0.5;
        // keep the point under the cursor fixed
        const nx = c.cx + fx * W * (1 / c.k - 1 / k);
        const ny = c.cy + fy * H * (1 / c.k - 1 / k);
        return clampCam({ k, cx: nx, cy: ny });
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [W, H, clampCam, view]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    const pts = [...pointers.current.values()];
    gesture.current = {
      startCam: cam,
      startPt: pts.length === 1 ? pts[0] : undefined,
      startDist: pts.length === 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : undefined,
      moved: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current || !svgRef.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const rect = svgRef.current.getBoundingClientRect();
    const g = gesture.current;
    if (pts.length === 2 && g.startDist) {
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      moved.current = true;
      setCam(clampCam({ ...g.startCam, k: g.startCam.k * (dist / g.startDist) }));
    } else if (pts.length === 1 && g.startPt && g.startCam.k > 1.01) {
      const dx = e.clientX - g.startPt.x;
      const dy = e.clientY - g.startPt.y;
      if (!moved.current && Math.hypot(dx, dy) < 6) return; // small jitter is a tap, not a pan
      moved.current = true;
      svgRef.current.setPointerCapture?.(e.pointerId);
      setCam(clampCam({ ...g.startCam, cx: g.startCam.cx - (dx / rect.width) * (W / g.startCam.k), cy: g.startCam.cy - (dy / rect.height) * (H / g.startCam.k) }));
    }
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
    else {
      const pts = [...pointers.current.values()];
      gesture.current = { startCam: cam, startPt: pts[0], moved: true };
    }
  };

  const vbW = W / cam.k;
  const vbH = H / cam.k;
  const viewBox = `${cam.cx - vbW / 2} ${cam.cy - vbH / 2} ${vbW} ${vbH}`;

  // ---- seat info
  const seatsById = useMemo(() => new Map(data.seats.map((s) => [s.id, s])), [data.seats]);
  const describe = (s: MapSeat): string => {
    const zone = zoneById.get(s.zoneId)?.name ?? "";
    const stateText = t(`state_${s.state}`);
    return [s.label, zone, stateText, s.nickname].filter(Boolean).join(" · ");
  };
  const infoSeat = seatsById.get(activeId ?? selectedId ?? "") ?? null;
  const selected = selectedId ? seatsById.get(selectedId) ?? null : null;
  const canPick = !!data.pick || !!checkout;

  const choose = (s: MapSeat) => {
    if (!s.selectable) return;
    setSelectedId(s.id);
    setResult(null);
  };

  const confirm = async () => {
    if (!data.pick || !selected) return;
    setBusy(true);
    try {
      const r = await chooseSeatAction(data.pick.ticketId, selected.id);
      setResult(r);
      if (r.ok) {
        setSelectedId(null);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- list view data
  const listSeats = useMemo(() => {
    return [...data.seats]
      .filter((s) => (zoneFilter ? s.zoneId === zoneFilter : true))
      .filter((s) => (onlyFree ? s.state === "free" || s.state === "mine" : true))
      .sort((a, b) => a.label.localeCompare(b.label, "sv", { numeric: true }));
  }, [data.seats, zoneFilter, onlyFree]);

  const sampleColor = data.zones[0]?.color ?? "#0072B2";
  const freeCount = data.seats.filter((s) => s.state === "free").length;

  return (
    <section aria-labelledby="seatmap-h" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="seatmap-h" className="text-xl font-semibold">{t("title")}</h2>
        <div role="group" aria-label={t("viewSwitch")} className="inline-flex overflow-hidden rounded-full border-2 border-ink">
          {(["map", "list"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} className={`min-h-11 px-4 text-sm font-bold ${view === v ? "bg-hay text-ink" : "bg-card hover:bg-slate-100"}`}>
              {t(`view_${v}`)}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-slate-700">{t("summary", { free: freeCount, total: data.seats.length })}</p>
      {!checkout && <PickNotice data={data} viewer={viewer} ticketLabel={ticketLabel} />}

      {view === "map" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => zoomBy(1.4)} aria-label={t("zoomIn")}>＋</button>
            <button type="button" className="btn-secondary" onClick={() => zoomBy(1 / 1.4)} aria-label={t("zoomOut")}>－</button>
            <button type="button" className="btn-secondary" onClick={resetCam}>{t("zoomReset")}</button>
            <span className="text-sm text-slate-600" aria-hidden="true">{Math.round(cam.k * 100)}%</span>
          </div>
          <div className="overflow-hidden rounded-[10px] border-2 border-ink bg-night shadow-sticker-lg">
            <svg
              ref={svgRef}
              viewBox={viewBox}
              role="group"
              aria-label={t("mapLabel")}
              className="block w-full select-none"
              style={{ aspectRatio: `${W} / ${H}`, touchAction: cam.k > 1.01 ? "none" : "pan-y" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <SeatDefs />
              <rect x={0} y={0} width={W} height={H} fill="#0f2118" />
              {data.objects.map((o) => (
                <ObjectShape key={o.id} o={o} kindLabels={kindLabels} />
              ))}
              {data.seats.map((s) => {
                const zone = zoneById.get(s.zoneId);
                const interactive = s.selectable;
                const dim = canPick && s.state === "free" && !s.selectable;
                return (
                  <g
                    key={s.id}
                    transform={`translate(${s.x} ${s.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={describe(s)}
                    aria-pressed={interactive ? selectedId === s.id : undefined}
                    aria-disabled={!interactive}
                    style={{ cursor: interactive ? "pointer" : "default", outline: "none" }}
                    onClick={() => !moved.current && choose(s)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        choose(s);
                      }
                    }}
                    onPointerEnter={() => setActiveId(s.id)}
                    onPointerLeave={() => setActiveId((a) => (a === s.id ? null : a))}
                    onFocus={() => setActiveId(s.id)}
                    onBlur={() => setActiveId((a) => (a === s.id ? null : a))}
                  >
                    <title>{describe(s)}</title>
                    {/* generous invisible hit area (≥ 36 units) for fingers */}
                    <rect x={-18} y={-18} width={36} height={36} fill="transparent" />
                    <SeatShape state={s.state} color={zone?.color ?? "#999999"} label={s.label} rotation={s.rotation} dim={dim} selected={selectedId === s.id || activeId === s.id} />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      ) : (
        <SeatList
          seats={listSeats}
          zones={data.zones}
          zoneFilter={zoneFilter}
          setZoneFilter={setZoneFilter}
          onlyFree={onlyFree}
          setOnlyFree={setOnlyFree}
          canPick={canPick}
          selectedId={selectedId}
          onSelect={choose}
          describe={describe}
          zoneColor={(id) => zoneById.get(id)?.color ?? "#999999"}
        />
      )}

      {/* what the focused / hovered / selected seat is (also read out to screen readers) */}
      <p aria-live="polite" className="min-h-6 rounded bg-slate-100 px-3 py-2 text-sm">
        {infoSeat ? describe(infoSeat) : t("hint")}
      </p>

      {checkout && (
        <div className="space-y-2 rounded-lg border border-brand-500 bg-brand-50 p-4" role="status">
          {selected ? (
            <>
              <p className="font-semibold">{t("checkoutChosen", { seat: selected.label })}</p>
              <p className="text-sm">{t("checkoutHold")}</p>
              <button type="button" className="btn-secondary" onClick={() => checkout.onChange(null)}>{t("checkoutClear")}</button>
            </>
          ) : (
            <p>{t("checkoutPick")}</p>
          )}
        </div>
      )}

      {data.pick && !checkout && (
        <div className="space-y-2 rounded-lg border border-brand-500 bg-brand-50 p-4">
          {selected ? (
            <>
              <p className="font-semibold">
                {data.pick?.currentSeatId ? t("moveTo", { seat: selected.label }) : t("chooseSeat", { seat: selected.label })}
              </p>
              <button type="button" className="btn w-full sm:w-auto" onClick={confirm} disabled={busy}>
                {busy ? tAll("auth.submitting") : data.pick?.currentSeatId ? t("confirmMove") : t("confirmChoose")}
              </button>
            </>
          ) : (
            <p>{data.pick?.currentSeatId ? t("pickToMove", { seat: seatsById.get(data.pick.currentSeatId)?.label ?? "" }) : t("pickOne")}</p>
          )}
          {result && (
            <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-green-800" : "font-medium text-red-700"}>
              {tAll(result.message)}
            </p>
          )}
        </div>
      )}

      <Legend zones={data.zones} sampleColor={sampleColor} canPick={canPick} />
    </section>
  );
}

function PickNotice({ data, viewer, ticketLabel }: { data: SeatMapData; viewer: Viewer; ticketLabel?: string }) {
  const t = useTranslations("seats");
  let text: string | null = null;
  if (data.pick) text = data.pick.currentSeatId ? t("notice_hasSeat") : t("notice_canPick", { ticket: ticketLabel ?? "" });
  else if (data.pickBlockedReason) text = t(`blocked_${data.pickBlockedReason}`);
  else if (viewer === "visitor") text = t("notice_visitor");
  else text = t("notice_noTicket");
  return <p className="rounded-md border border-slate-300 bg-white p-3 text-sm">{text}</p>;
}

function Legend({ zones, sampleColor, canPick }: { zones: SeatMapData["zones"]; sampleColor: string; canPick: boolean }) {
  const t = useTranslations("seats");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <h3 className="mb-2 font-semibold">{t("legend")}</h3>
        <ul className="space-y-1 text-sm">
          <LegendItem state="free" color={sampleColor} text={t("state_free")} />
          <LegendItem state="mine" color={sampleColor} text={t("state_mine")} />
          <LegendItem state="taken" color={sampleColor} text={t("state_taken")} />
          <LegendItem state="blocked" color={sampleColor} text={t("state_blocked")} />
          <LegendItem state="reserved" color={sampleColor} text={t("state_reserved")} />
          {canPick && <LegendItem state="free" color={sampleColor} text={t("state_unavailable")} dim />}
        </ul>
      </div>
      <div>
        <h3 className="mb-2 font-semibold">{t("zones")}</h3>
        <ul className="space-y-1 text-sm">
          {zones.map((z) => (
            <li key={z.id} className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block h-5 w-5 rounded border border-slate-700" style={{ background: z.color }} />
              {z.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SeatList({
  seats, zones, zoneFilter, setZoneFilter, onlyFree, setOnlyFree, canPick, selectedId, onSelect, describe, zoneColor,
}: {
  seats: MapSeat[];
  zones: SeatMapData["zones"];
  zoneFilter: string;
  setZoneFilter: (v: string) => void;
  onlyFree: boolean;
  setOnlyFree: (v: boolean) => void;
  canPick: boolean;
  selectedId: string | null;
  onSelect: (s: MapSeat) => void;
  describe: (s: MapSeat) => string;
  zoneColor: (id: string) => string;
}) {
  const t = useTranslations("seats");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="seat-zone-filter" className="block text-sm font-medium">{t("filterZone")}</label>
          <select id="seat-zone-filter" className="input mt-1 w-auto" value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)}>
            <option value="">{t("allZones")}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
          {t("onlyFree")}
        </label>
      </div>
      <p className="text-sm text-slate-600" role="status">{t("listCount", { count: seats.length })}</p>
      {seats.length === 0 ? (
        <p>{t("listEmpty")}</p>
      ) : (
        <fieldset className="max-h-96 overflow-auto rounded-lg border border-slate-300 bg-white">
          <legend className="sr-only">{t("listLegend")}</legend>
          <ul className="divide-y divide-slate-200">
            {seats.map((s) => (
              <li key={s.id}>
                <label className={`flex min-h-12 items-center gap-3 px-3 py-2 ${s.selectable ? "cursor-pointer hover:bg-slate-50" : "text-slate-600"}`}>
                  {canPick ? (
                    <input type="radio" name="seat-choice" className="h-5 w-5" disabled={!s.selectable} checked={selectedId === s.id} onChange={() => onSelect(s)} />
                  ) : null}
                  <span aria-hidden="true" className="inline-block h-4 w-4 shrink-0 rounded-sm border border-slate-700" style={{ background: zoneColor(s.zoneId) }} />
                  <span>{describe(s)}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </div>
  );
}
