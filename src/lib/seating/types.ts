import type { ChartObjectKind } from "@prisma/client";

export const SEAT_SIZE = 28;

/** Okabe–Ito palette: distinguishable for the common kinds of colour blindness. */
export const ZONE_COLORS = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#56B4E9", "#CC79A7", "#F0E442"] as const;

export interface ZoneData {
  id: string;
  name: string;
  color: string;
}

export interface SeatData {
  id: string;
  label: string;
  x: number;
  y: number;
  rotation: number;
  zoneId: string;
  groupId: string | null;
  blocked: boolean;
  reservedForUserId: string | null;
  /** Editor display only (nickname of the reserved-for user). Ignored on save. */
  reservedForLabel?: string | null;
}

export interface ObjectData {
  id: string;
  kind: ChartObjectKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  label: string | null;
}

export interface ChartData {
  id: string;
  name: string;
  width: number;
  height: number;
  gridSize: number;
  zones: ZoneData[];
  seats: SeatData[];
  objects: ObjectData[];
}

/** What a viewer sees of one seat on the booking map. */
export type SeatState = "free" | "taken" | "blocked" | "reserved" | "mine";

export interface MapSeat {
  id: string;
  label: string;
  x: number;
  y: number;
  rotation: number;
  zoneId: string;
  state: SeatState;
  /** Only present for taken seats when the event shows nicknames. */
  nickname?: string;
  /** Can this viewer pick this seat right now? */
  selectable: boolean;
}

export interface SeatMapData {
  chart: { width: number; height: number; gridSize: number };
  zones: ZoneData[];
  objects: ObjectData[];
  seats: MapSeat[];
  showNicknames: boolean;
  /** The viewer's own ticket that may choose a seat (null: none / not allowed). */
  pick: { ticketId: string; currentSeatId: string | null; allowedZoneIds: string[] | null } | null;
  /** Why picking is unavailable for a logged-in viewer with a ticket, if so. */
  pickBlockedReason: "unverified" | "deadlinePassed" | "eventNotOpen" | "noSeatTicket" | "ticketNotActive" | null;
}
