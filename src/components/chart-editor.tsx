"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChartObjectKind } from "@prisma/client";
import { useTranslations } from "next-intl";
import { saveChartAction, searchUsersAction } from "@/actions/seating";
import { findDuplicateLabels, nextPrefix, snap } from "@/lib/seating/geometry";
import {
  addObject, addRow, addSeat, addTable, addZone, canDeleteZone, clampDelta, deleteItems, deleteZone, itemsInRect, moveItems, objectKey,
  patchObject, patchSeats, patchZone, relabelSeats, rotateItems, seatKey, toPayload, type Doc, type Key,
} from "@/lib/seating/editor-ops";
import { SEAT_SIZE, ZONE_COLORS, type ChartData } from "@/lib/seating/types";
import { ObjectShape, SeatDefs, SeatShape } from "./seat-glyph";

const KINDS: ChartObjectKind[] = ["STAGE", "ENTRANCE", "KITCHEN", "TOILET", "TABLE", "WALL", "LABEL"];

interface History {
  past: Doc[];
  present: Doc;
  future: Doc[];
}

const toDoc = (c: ChartData): Doc => ({ name: c.name, width: c.width, height: c.height, gridSize: c.gridSize, zones: c.zones, seats: c.seats, objects: c.objects });

export function ChartEditor({ chartId, initial, isTemplate }: { chartId: string; initial: ChartData; isTemplate: boolean }) {
  const t = useTranslations("editor");
  const tAll = useTranslations();

  const [history, setHistory] = useState<History>({ past: [], present: toDoc(initial), future: [] });
  const doc = history.present;
  const savedRef = useRef<Doc>(history.present);
  const dirty = doc !== savedRef.current;

  const commit = useCallback((next: Doc) => setHistory((h) => (next === h.present ? h : { past: [...h.past.slice(-49), h.present], present: next, future: [] })), []);
  const undo = useCallback(() => setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] } : h)), []);
  const redo = useCallback(() => setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) } : h)), []);

  const [sel, setSel] = useState<Set<Key>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ keys: Set<Key>; dx: number; dy: number } | null>(null);
  const [band, setBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const bandStart = useRef<{ x: number; y: number; additive: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // tool parameters
  const firstZone = doc.zones[0]?.id ?? "";
  const [rowCount, setRowCount] = useState(10);
  const [rowPrefix, setRowPrefix] = useState("A");
  const [rowOrient, setRowOrient] = useState<"horizontal" | "vertical">("horizontal");
  const [rowZone, setRowZone] = useState(firstZone);
  const [tableCount, setTableCount] = useState(6);
  const [tablePrefix, setTablePrefix] = useState("T1-");
  const [tableZone, setTableZone] = useState(firstZone);
  const [autoPrefix, setAutoPrefix] = useState("A");
  const [autoStart, setAutoStart] = useState(1);
  const [autoAxis, setAutoAxis] = useState<"x" | "y">("x");

  const [message, setMessage] = useState<{ ok: boolean; text: string; labels?: string[] } | null>(null);
  const [saving, setSaving] = useState(false);

  // reserved-for search
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; nickname: string; email: string }[] | null>(null);

  // zone selects must always point at an existing zone
  const zoneIds = useMemo(() => new Set(doc.zones.map((z) => z.id)), [doc.zones]);
  const safeRowZone = zoneIds.has(rowZone) ? rowZone : firstZone;
  const safeTableZone = zoneIds.has(tableZone) ? tableZone : firstZone;
  const zoneById = useMemo(() => new Map(doc.zones.map((z) => [z.id, z])), [doc.zones]);
  const kindLabels = useMemo(() => Object.fromEntries(KINDS.map((k) => [k, t(`kind_${k}`)])), [t]);

  const duplicates = useMemo(() => findDuplicateLabels(doc.seats), [doc.seats]);
  const duplicateLabels = useMemo(() => [...new Set(doc.seats.filter((s) => duplicates.has(s.id)).map((s) => s.label.trim().toLowerCase()))].slice(0, 8), [doc.seats, duplicates]);
  const emptyLabel = doc.seats.some((s) => s.label.trim() === "");

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // ---------- selection helpers
  const selSeatIds = useMemo(() => new Set(doc.seats.filter((s) => sel.has(seatKey(s.id))).map((s) => s.id)), [doc.seats, sel]);
  const selObjects = useMemo(() => doc.objects.filter((o) => sel.has(objectKey(o.id))), [doc.objects, sel]);
  const selSeats = useMemo(() => doc.seats.filter((s) => selSeatIds.has(s.id)), [doc.seats, selSeatIds]);

  const apply = (r: { doc: Doc; keys: Set<Key> }) => {
    commit(r.doc);
    setSel(r.keys);
    setRowPrefix(nextPrefix(r.doc.seats.map((s) => s.label)));
  };
  const viewCentre = () => {
    const el = svgRef.current?.parentElement;
    if (!el) return undefined;
    return { x: (el.scrollLeft + el.clientWidth / 2) / zoom, y: (el.scrollTop + el.clientHeight / 2) / zoom };
  };

  // ---------- pointer interaction
  const toChart = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };

  const onItemPointerDown = (e: React.PointerEvent, key: Key) => {
    e.stopPropagation();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSel((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      });
      return;
    }
    const keys = sel.has(key) ? sel : new Set([key]);
    setSel(keys);
    dragStart.current = toChart(e);
    setDrag({ keys, dx: 0, dy: 0 });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    const p = toChart(e);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    bandStart.current = { ...p, additive };
    setBand({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    if (!additive) setSel(new Set());
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragStart.current && drag) {
      const p = toChart(e);
      const raw = { dx: snap(p.x - dragStart.current.x, doc.gridSize), dy: snap(p.y - dragStart.current.y, doc.gridSize) };
      const c = clampDelta(doc, drag.keys, raw.dx, raw.dy);
      if (c.dx !== drag.dx || c.dy !== drag.dy) setDrag({ keys: drag.keys, ...c });
    } else if (bandStart.current) {
      const p = toChart(e);
      setBand({ x1: bandStart.current.x, y1: bandStart.current.y, x2: p.x, y2: p.y });
    }
  };

  const onPointerUp = () => {
    if (drag && (drag.dx !== 0 || drag.dy !== 0)) commit(moveItems(doc, drag.keys, drag.dx, drag.dy));
    if (band && bandStart.current && Math.hypot(band.x2 - band.x1, band.y2 - band.y1) > 4) {
      const hit = itemsInRect(doc, band);
      setSel((s) => (bandStart.current?.additive ? new Set([...s, ...hit]) : hit));
    }
    dragStart.current = null;
    bandStart.current = null;
    setDrag(null);
    setBand(null);
  };

  // ---------- keyboard
  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel(new Set([...doc.seats.map((s) => seatKey(s.id)), ...doc.objects.map((o) => objectKey(o.id))]));
    } else if (e.key === "Escape") {
      setSel(new Set());
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (sel.size) {
        e.preventDefault();
        commit(deleteItems(doc, sel));
        setSel(new Set());
      }
    } else if (e.key.startsWith("Arrow")) {
      const focused = (e.target as HTMLElement).closest?.("[data-key]")?.getAttribute("data-key");
      const keys = sel.size ? sel : focused ? new Set([focused]) : new Set<Key>();
      if (!keys.size) return;
      e.preventDefault();
      const step = doc.gridSize * (e.shiftKey ? 5 : 1);
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      if (!sel.size) setSel(keys);
      commit(moveItems(doc, keys, dx, dy));
    }
  };

  // ---------- save
  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const r = await saveChartAction(chartId, toPayload(doc));
      if (r.ok) {
        const fresh = toDoc(r.chart);
        savedRef.current = fresh;
        setHistory({ past: [], present: fresh, future: [] });
        setSel(new Set());
        setMessage({ ok: true, text: "messages.chartSaved" });
      } else {
        setMessage({ ok: false, text: r.message, labels: r.labels });
      }
    } finally {
      setSaving(false);
    }
  };

  const searchReserved = async () => setResults(await searchUsersAction(q));

  // ---------- rendering helpers
  const pos = (key: Key, x: number, y: number) => (drag?.keys.has(key) ? { x: x + drag.dx, y: y + drag.dy } : { x, y });
  const singleSeat = selSeats.length === 1 && selObjects.length === 0 ? selSeats[0]! : null;
  const singleObject = selObjects.length === 1 && selSeats.length === 0 ? selObjects[0]! : null;
  const sameZone = selSeats.length > 0 && selSeats.every((s) => s.zoneId === selSeats[0]!.zoneId) ? selSeats[0]!.zoneId : "";
  const allBlocked = selSeats.length > 0 && selSeats.every((s) => s.blocked);
  const itemBtn = "btn-secondary";

  return (
    <div className="space-y-4" onKeyDown={onKeyDown}>
      {/* top bar */}
      <div className="card flex flex-wrap items-end gap-4">
        <div className="min-w-48 grow">
          <label htmlFor="chart-name" className="block text-sm font-medium">{t("name")}</label>
          <input id="chart-name" className="input" value={doc.name} maxLength={100} onChange={(e) => commit({ ...doc, name: e.target.value })} />
        </div>
        <NumberField id="chart-w" label={t("width")} value={doc.width} min={200} max={5000} step={doc.gridSize} onChange={(v) => commit({ ...doc, width: v })} />
        <NumberField id="chart-h" label={t("height")} value={doc.height} min={200} max={5000} step={doc.gridSize} onChange={(v) => commit({ ...doc, height: v })} />
        <div>
          <label htmlFor="chart-grid" className="block text-sm font-medium">{t("grid")}</label>
          <select id="chart-grid" className="input w-24" value={doc.gridSize} onChange={(e) => commit({ ...doc, gridSize: Number(e.target.value) })}>
            {[10, 20, 25, 40].map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button type="button" className={itemBtn} onClick={undo} disabled={!history.past.length}>{t("undo")}</button>
          <button type="button" className={itemBtn} onClick={redo} disabled={!history.future.length}>{t("redo")}</button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={itemBtn} aria-label={t("zoomOut")} onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))}>－</button>
          <span className="w-12 text-center text-sm" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" className={itemBtn} aria-label={t("zoomIn")} onClick={() => setZoom((z) => Math.min(2, +(z + 0.25).toFixed(2)))}>＋</button>
        </div>
        <button type="button" className="btn" onClick={save} disabled={saving || !dirty || duplicates.size > 0 || emptyLabel}>
          {saving ? t("saving") : t("save")}
        </button>
        <span className="text-sm text-slate-600" role="status">{dirty ? t("unsaved") : t("allSaved")}</span>
      </div>

      {isTemplate && <p className="rounded-md border border-slate-300 bg-white p-3 text-sm">{t("templateNote")}</p>}
      {(duplicates.size > 0 || emptyLabel) && (
        <p role="alert" className="rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-900">
          {emptyLabel ? t("emptyLabel") : t("dupWarning", { labels: duplicateLabels.join(", ") })}
        </p>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={`rounded-md border p-3 text-sm ${message.ok ? "border-green-400 bg-green-50 text-green-900" : "border-red-400 bg-red-50 text-red-900"}`}>
          {tAll(message.text)}
          {message.labels && message.labels.length > 0 && <strong> {message.labels.join(", ")}</strong>}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* canvas */}
        <div className="max-h-[75vh] min-h-64 overflow-auto rounded-lg border border-slate-400 bg-slate-200">
          <svg
            ref={svgRef}
            width={doc.width * zoom}
            height={doc.height * zoom}
            viewBox={`0 0 ${doc.width} ${doc.height}`}
            role="group"
            aria-label={t("canvasLabel")}
            className="block select-none"
            style={{ touchAction: "none" }}
            onPointerDown={onBackgroundPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <SeatDefs />
            <defs>
              <pattern id="editor-grid" width={doc.gridSize} height={doc.gridSize} patternUnits="userSpaceOnUse">
                <path d={`M ${doc.gridSize} 0 L 0 0 0 ${doc.gridSize}`} fill="none" stroke="#cbd5e1" strokeWidth={0.5} />
              </pattern>
            </defs>
            <rect width={doc.width} height={doc.height} fill="#ffffff" />
            <rect width={doc.width} height={doc.height} fill="url(#editor-grid)" />

            {doc.objects.map((o) => {
              const key = objectKey(o.id);
              const p = pos(key, o.x, o.y);
              return (
                <g
                  key={o.id}
                  data-key={key}
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel.has(key)}
                  aria-label={`${o.label || kindLabels[o.kind]} (${kindLabels[o.kind]})`}
                  onPointerDown={(e) => onItemPointerDown(e, key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSel((s) => (e.shiftKey ? new Set(s).add(key) : new Set([key])));
                    }
                  }}
                  style={{ cursor: "move", outline: "none" }}
                >
                  <ObjectShape o={{ ...o, x: p.x, y: p.y }} kindLabels={kindLabels} selected={sel.has(key)} />
                </g>
              );
            })}

            {doc.seats.map((s) => {
              const key = seatKey(s.id);
              const p = pos(key, s.x, s.y);
              const zone = zoneById.get(s.zoneId);
              const state = s.blocked ? "blocked" : s.reservedForUserId ? "reserved" : "free";
              const dupe = duplicates.has(s.id);
              return (
                <g
                  key={s.id}
                  data-key={key}
                  transform={`translate(${p.x} ${p.y})`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel.has(key)}
                  aria-label={t("seatAria", { label: s.label, zone: zone?.name ?? "", state: t(`state_${state}`) })}
                  onPointerDown={(e) => onItemPointerDown(e, key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSel((cur) => (e.shiftKey ? new Set(cur).add(key) : new Set([key])));
                    }
                  }}
                  style={{ cursor: "move", outline: "none" }}
                >
                  <rect x={-18} y={-18} width={36} height={36} fill="transparent" />
                  <SeatShape state={state} color={zone?.color ?? "#999999"} label={s.label} rotation={s.rotation} selected={sel.has(key)} />
                  {state === "reserved" && <text y={SEAT_SIZE / 2 + 9} textAnchor="middle" fontSize={8} fill="#111827" pointerEvents="none">{s.label}</text>}
                  {dupe && <circle cx={12} cy={-12} r={6} fill="#dc2626" stroke="#fff" strokeWidth={1.5} />}
                </g>
              );
            })}

            {band && <rect x={Math.min(band.x1, band.x2)} y={Math.min(band.y1, band.y2)} width={Math.abs(band.x2 - band.x1)} height={Math.abs(band.y2 - band.y1)} fill="#2563eb22" stroke="#2563eb" strokeDasharray="4 3" />}
          </svg>
        </div>

        {/* side panels */}
        <div className="space-y-4">
          <section className="card space-y-3" aria-labelledby="add-h">
            <h2 id="add-h" className="font-semibold">{t("add")}</h2>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("row")}</legend>
              <div className="grid grid-cols-2 gap-2">
                <NumberField id="row-count" label={t("rowCount")} value={rowCount} min={1} max={60} onChange={setRowCount} />
                <TextField id="row-prefix" label={t("rowPrefix")} value={rowPrefix} onChange={setRowPrefix} maxLength={6} />
                <SelectField id="row-orient" label={t("orientation")} value={rowOrient} onChange={(v) => setRowOrient(v as "horizontal" | "vertical")} options={[["horizontal", t("horizontal")], ["vertical", t("vertical")]]} />
                <SelectField id="row-zone" label={t("zone")} value={safeRowZone} onChange={setRowZone} options={doc.zones.map((z) => [z.id, z.name])} />
              </div>
              <button type="button" className={itemBtn} disabled={!rowPrefix.trim()} onClick={() => apply(addRow(doc, { count: rowCount, prefix: rowPrefix.trim(), orientation: rowOrient, zoneId: safeRowZone, centre: viewCentre() }))}>{t("addRow")}</button>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("tableGroup")}</legend>
              <div className="grid grid-cols-2 gap-2">
                <NumberField id="table-count" label={t("tableSeats")} value={tableCount} min={1} max={40} onChange={setTableCount} />
                <TextField id="table-prefix" label={t("rowPrefix")} value={tablePrefix} onChange={setTablePrefix} maxLength={8} />
                <SelectField id="table-zone" label={t("zone")} value={safeTableZone} onChange={setTableZone} options={doc.zones.map((z) => [z.id, z.name])} />
              </div>
              <button type="button" className={itemBtn} disabled={!tablePrefix.trim()} onClick={() => { apply(addTable(doc, { count: tableCount, prefix: tablePrefix.trim(), zoneId: safeTableZone, centre: viewCentre() })); setTablePrefix(`T${Number(/\d+/.exec(tablePrefix)?.[0] ?? 0) + 1}-`); }}>{t("addTable")}</button>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={itemBtn} onClick={() => apply(addSeat(doc, { zoneId: safeRowZone, centre: viewCentre() }))}>{t("addSeat")}</button>
              {KINDS.map((k) => (
                <button key={k} type="button" className={itemBtn} onClick={() => apply(addObject(doc, { kind: k, centre: viewCentre() }))}>{kindLabels[k]}</button>
              ))}
            </div>
          </section>

          <section className="card space-y-3" aria-labelledby="sel-h">
            <h2 id="sel-h" className="font-semibold">{t("selection")}</h2>
            {sel.size === 0 ? (
              <p className="text-sm text-slate-600">{t("nothingSelected")}</p>
            ) : (
              <>
                <p className="text-sm" role="status">{t("selectedCount", { seats: selSeats.length, objects: selObjects.length })}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={itemBtn} onClick={() => commit(rotateItems(doc, sel, -15))}>{t("rotateLeft")}</button>
                  <button type="button" className={itemBtn} onClick={() => commit(rotateItems(doc, sel, 15))}>{t("rotateRight")}</button>
                  <button type="button" className={itemBtn} onClick={() => commit(rotateItems(doc, sel, 90))}>{t("rotate90")}</button>
                  <button type="button" className="btn-danger" onClick={() => { commit(deleteItems(doc, sel)); setSel(new Set()); }}>{t("delete")}</button>
                </div>

                {selSeats.length > 0 && (
                  <>
                    <SelectField
                      id="sel-zone"
                      label={t("zone")}
                      value={sameZone}
                      onChange={(v) => v && commit(patchSeats(doc, selSeatIds, { zoneId: v }))}
                      options={[...(sameZone ? [] : [["", t("mixed")] as [string, string]]), ...doc.zones.map((z) => [z.id, z.name] as [string, string])]}
                    />
                    <label className="flex items-center gap-3 text-sm">
                      <input type="checkbox" className="h-5 w-5" checked={allBlocked} onChange={(e) => commit(patchSeats(doc, selSeatIds, { blocked: e.target.checked }))} />
                      {t("blocked")}
                    </label>
                  </>
                )}

                {singleSeat && (
                  <div className="space-y-2">
                    <TextField id="seat-label" label={t("label")} value={singleSeat.label} maxLength={12} onChange={(v) => commit(patchSeats(doc, selSeatIds, { label: v }))} />
                    <div className="grid grid-cols-3 gap-2">
                      <NumberField id="seat-x" label="X" value={Math.round(singleSeat.x)} onChange={(v) => commit(patchSeats(doc, selSeatIds, { x: v }))} />
                      <NumberField id="seat-y" label="Y" value={Math.round(singleSeat.y)} onChange={(v) => commit(patchSeats(doc, selSeatIds, { y: v }))} />
                      <NumberField id="seat-rot" label={t("rotation")} value={Math.round(singleSeat.rotation)} min={0} max={360} onChange={(v) => commit(patchSeats(doc, selSeatIds, { rotation: v }))} />
                    </div>
                    <div className="space-y-2 rounded border border-slate-300 p-2">
                      <p className="text-sm font-medium">{t("reservedFor")}: {singleSeat.reservedForUserId ? <strong>{singleSeat.reservedForLabel ?? singleSeat.reservedForUserId}</strong> : <span className="text-slate-600">{t("reservedNone")}</span>}</p>
                      <div className="flex gap-2">
                        <label htmlFor="reserve-q" className="sr-only">{t("reserveSearch")}</label>
                        <input id="reserve-q" className="input mt-0" value={q} placeholder={t("reserveSearch")} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void searchReserved(); } }} />
                        <button type="button" className={itemBtn} onClick={searchReserved}>{t("search")}</button>
                      </div>
                      {results && (results.length === 0 ? <p className="text-sm">{t("noResults")}</p> : (
                        <ul className="space-y-1">
                          {results.map((u) => (
                            <li key={u.id}>
                              <button type="button" className="w-full rounded border border-slate-300 px-2 py-2 text-left text-sm hover:bg-slate-100" onClick={() => { commit(patchSeats(doc, selSeatIds, { reservedForUserId: u.id, reservedForLabel: u.nickname })); setResults(null); setQ(""); }}>
                                <strong>{u.nickname}</strong> <span className="text-slate-600">{u.email}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ))}
                      {singleSeat.reservedForUserId && <button type="button" className={itemBtn} onClick={() => commit(patchSeats(doc, selSeatIds, { reservedForUserId: null, reservedForLabel: null }))}>{t("clearReservation")}</button>}
                    </div>
                  </div>
                )}

                {selSeats.length > 1 && (
                  <fieldset className="space-y-2 rounded border border-slate-300 p-2">
                    <legend className="px-1 text-sm font-medium">{t("autoLabel")}</legend>
                    <div className="grid grid-cols-3 gap-2">
                      <TextField id="auto-prefix" label={t("rowPrefix")} value={autoPrefix} maxLength={6} onChange={setAutoPrefix} />
                      <NumberField id="auto-start" label={t("autoStart")} value={autoStart} min={0} max={999} onChange={setAutoStart} />
                      <SelectField id="auto-axis" label={t("autoAxis")} value={autoAxis} onChange={(v) => setAutoAxis(v as "x" | "y")} options={[["x", t("axisX")], ["y", t("axisY")]]} />
                    </div>
                    <button type="button" className={itemBtn} disabled={!autoPrefix.trim()} onClick={() => commit(relabelSeats(doc, selSeatIds, { prefix: autoPrefix.trim(), start: autoStart, axis: autoAxis }))}>{t("numberSelected")}</button>
                  </fieldset>
                )}

                {singleObject && (
                  <div className="space-y-2">
                    <TextField id="obj-label" label={t("objectLabel")} value={singleObject.label ?? ""} maxLength={60} onChange={(v) => commit(patchObject(doc, singleObject.id, { label: v || null }))} />
                    <div className="grid grid-cols-2 gap-2">
                      <NumberField id="obj-w" label={t("objectWidth")} value={Math.round(singleObject.width)} min={1} max={5000} onChange={(v) => commit(patchObject(doc, singleObject.id, { width: v }))} />
                      <NumberField id="obj-h" label={t("objectHeight")} value={Math.round(singleObject.height)} min={1} max={5000} onChange={(v) => commit(patchObject(doc, singleObject.id, { height: v }))} />
                      <NumberField id="obj-x" label="X" value={Math.round(singleObject.x)} onChange={(v) => commit(patchObject(doc, singleObject.id, { x: v }))} />
                      <NumberField id="obj-y" label="Y" value={Math.round(singleObject.y)} onChange={(v) => commit(patchObject(doc, singleObject.id, { y: v }))} />
                      <NumberField id="obj-rot" label={t("rotation")} value={Math.round(singleObject.rotation)} min={0} max={360} onChange={(v) => commit(patchObject(doc, singleObject.id, { rotation: v }))} />
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="card space-y-3" aria-labelledby="zones-h">
            <h2 id="zones-h" className="font-semibold">{t("zonesTitle")}</h2>
            <ul className="space-y-3">
              {doc.zones.map((z, i) => (
                <li key={z.id} className="space-y-2 rounded border border-slate-200 p-2">
                  <div className="flex items-end gap-2">
                    <div className="grow">
                      <TextField id={`zone-name-${i}`} label={t("zoneName")} value={z.name} maxLength={60} onChange={(v) => commit(patchZone(doc, z.id, { name: v }))} />
                    </div>
                    <div>
                      <label htmlFor={`zone-color-${i}`} className="block text-sm font-medium">{t("zoneColor")}</label>
                      <input id={`zone-color-${i}`} type="color" className="mt-1 h-11 w-14 rounded border border-slate-500" value={z.color} onChange={(e) => commit(patchZone(doc, z.id, { color: e.target.value }))} />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("palette")}>
                    {ZONE_COLORS.map((c) => (
                      <button key={c} type="button" aria-label={c} aria-pressed={z.color.toLowerCase() === c.toLowerCase()} onClick={() => commit(patchZone(doc, z.id, { color: c }))} className="h-8 w-8 rounded border border-slate-700" style={{ background: c, outline: z.color.toLowerCase() === c.toLowerCase() ? "3px solid #111827" : undefined }} />
                    ))}
                    <button type="button" className="btn-secondary ml-auto" disabled={!canDeleteZone(doc, z.id)} title={canDeleteZone(doc, z.id) ? undefined : t("zoneInUseHint")} onClick={() => commit(deleteZone(doc, z.id))}>{t("deleteZone")}</button>
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" className={itemBtn} disabled={doc.zones.length >= 20} onClick={() => commit(addZone(doc, ZONE_COLORS[doc.zones.length % ZONE_COLORS.length]!, `${t("zone")} ${doc.zones.length + 1}`))}>{t("addZone")}</button>
          </section>

          <section className="card text-sm text-slate-700" aria-labelledby="help-h">
            <h2 id="help-h" className="mb-2 font-semibold">{t("helpTitle")}</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("help1")}</li>
              <li>{t("help2")}</li>
              <li>{t("help3")}</li>
              <li>{t("help4")}</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function TextField({ id, label, value, onChange, maxLength }: { id: string; label: string; value: string; onChange: (v: string) => void; maxLength?: number }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <input id={id} className="input" value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function NumberField({ id, label, value, onChange, min, max, step }: { id: string; label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  // Keep the typed text locally; only valid, in-range numbers are pushed up (so "3" on the way to "300" isn't clamped).
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        className="input"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n) && n >= (min ?? -Infinity) && n <= (max ?? Infinity)) onChange(n);
        }}
        onBlur={() => setText(String(value))}
      />
    </div>
  );
}

function SelectField({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
