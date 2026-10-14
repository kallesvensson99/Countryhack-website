"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { assertCan } from "@/lib/permissions";
import { chooseSeat } from "@/lib/seating/booking";
import { applyTemplate, createBlankChart, deleteTemplate, loadChartData, saveAsTemplate, saveChart, searchUsers, type ChartError } from "@/lib/seating/charts";
import type { ChartData } from "@/lib/seating/types";
import { chartPayloadSchema } from "@/lib/validation/chart";
import { formToObject, type ActionState } from "@/lib/validation/account";

export type SaveChartResponse = { ok: true; chart: ChartData } | { ok: false; message: string; labels?: string[] };

const CHART_ERRORS: Record<ChartError["reason"], string> = {
  notFound: "messages.notFound",
  eventCancelled: "messages.eventCancelled",
  invalidLabels: "messages.chartDuplicateLabels",
  badUser: "messages.chartBadUser",
  badChart: "messages.chartExists",
  seatHasClaim: "messages.chartSeatHasClaim",
  zoneIncompatible: "messages.chartZoneIncompatible",
  reservedConflict: "messages.chartReservedConflict",
  zoneInUse: "messages.chartZoneInUse",
};

/** Called directly from the editor with the full chart state. */
export async function saveChartAction(chartId: string, payload: unknown): Promise<SaveChartResponse> {
  const actor = await getCurrentUser();
  assertCan(actor, "chart:manage");
  const parsed = chartPayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, message: "messages.invalidInput" };
  const r = await saveChart(actor, chartId, parsed.data, await getClientIp());
  if (r.ok) {
    revalidatePath("/", "layout");
    // The editor swaps in the fresh state: server-assigned ids replace its temporary ones.
    return { ok: true, chart: (await loadChartData(chartId))! };
  }
  return { ok: false, message: CHART_ERRORS[r.reason], labels: "labels" in r ? r.labels : "names" in r ? r.names : undefined };
}

export async function searchUsersAction(q: string) {
  const actor = await getCurrentUser();
  assertCan(actor, "chart:manage");
  return searchUsers(actor, String(q).slice(0, 80));
}

const id = z.string().min(1).max(60);

export async function createChartAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "chart:manage");
  const raw = formToObject(fd);
  const eventId = id.safeParse(raw.eventId);
  if (!eventId.success) return { message: "messages.invalidInput" };
  const ip = await getClientIp();
  const r = raw.templateId ? await applyTemplate(actor, eventId.data, raw.templateId, ip) : await createBlankChart(actor, eventId.data, ip);
  if (!r.ok) return { message: CHART_ERRORS[r.reason] };
  redirect({ href: `/manage/events/${eventId.data}/chart`, locale: await getLocale() });
  return {};
}

export async function saveAsTemplateAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "template:manage");
  const raw = formToObject(fd);
  const eventId = id.safeParse(raw.eventId);
  const name = z.string().trim().min(1).max(100).safeParse(raw.name);
  if (!eventId.success || !name.success) return { message: "messages.invalidInput", values: { name: raw.name ?? "" } };
  const r = await saveAsTemplate(actor, eventId.data, name.data, await getClientIp());
  if (!r.ok) return { message: CHART_ERRORS[r.reason] };
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.templateSaved" };
}

export async function deleteTemplateAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "template:manage");
  const tid = id.safeParse(fd.get("id"));
  if (!tid.success) return { message: "messages.invalidInput" };
  const r = await deleteTemplate(actor, tid.data, await getClientIp());
  if (!r.ok) return { message: CHART_ERRORS[r.reason] };
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.templateDeleted" };
}

// ───────── Members: seat choice ─────────

const SEAT_ERRORS: Record<string, string> = {
  taken: "messages.seatTaken",
  blocked: "messages.seatBlocked",
  reservedForOther: "messages.seatReserved",
  zoneNotAllowed: "messages.seatZoneNotAllowed",
  ticketNoSeat: "messages.seatNoSeatTicket",
  ticketInactive: "messages.seatTicketInactive",
  wrongChart: "messages.notFound",
  alreadyHasSeat: "messages.seatTaken",
  noClaim: "messages.notFound",
  notFound: "messages.notFound",
  forbidden: "messages.notFound",
  deadlinePassed: "messages.seatDeadlinePassed",
  eventNotOpen: "messages.seatEventNotOpen",
};

export async function chooseSeatAction(ticketId: string, seatId: string): Promise<{ ok: boolean; message: string }> {
  const actor = await getCurrentUser();
  assertCan(actor, "seat:choose");
  if (typeof ticketId !== "string" || typeof seatId !== "string") return { ok: false, message: "messages.invalidInput" };
  const r = await chooseSeat(actor, ticketId, seatId, { ip: await getClientIp() });
  if (!r.ok) return { ok: false, message: SEAT_ERRORS[r.reason] ?? "messages.invalidInput" };
  revalidatePath("/", "layout");
  return { ok: true, message: r.moved ? "messages.seatMoved" : "messages.seatChosen" };
}
