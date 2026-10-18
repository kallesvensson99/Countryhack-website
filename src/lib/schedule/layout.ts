import { toStockholmInput } from "../time";

/** Anything that has a time span; the layout is pure so it can be tested without a database. */
export interface Span {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

export interface Block<T extends Span> {
  item: T;
  /** minutes after local (Stockholm) midnight of this day, clipped to the day */
  startMin: number;
  endMin: number;
  /** which column inside its overlap group, and how many columns that group has */
  lane: number;
  lanes: number;
  /** the item started on an earlier day / ends on a later one */
  fromPrevDay: boolean;
  toNextDay: boolean;
}

export interface Day<T extends Span> {
  /** yyyy-mm-dd, Stockholm */
  date: string;
  /** first and last whole hour shown on the time axis */
  startHour: number;
  endHour: number;
  blocks: Block<T>[];
}

const MIN_AXIS_HOURS = 4;

function local(d: Date): { date: string; min: number } {
  const s = toStockholmInput(d); // "YYYY-MM-DDTHH:mm" in Stockholm time
  return { date: s.slice(0, 10), min: Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)) };
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Splits items into days (an item that runs past midnight continues on the next day) and places overlapping blocks
 * side by side: every connected group of overlapping blocks is divided into as many columns as it needs.
 */
export function buildDays<T extends Span>(items: T[]): Day<T>[] {
  const perDay = new Map<string, Omit<Block<T>, "lane" | "lanes">[]>();
  for (const item of items) {
    if (item.endsAt <= item.startsAt) continue;
    const s = local(item.startsAt);
    const e = local(item.endsAt);
    for (let date = s.date; date <= e.date; date = nextDate(date)) {
      const startMin = date === s.date ? s.min : 0;
      const endMin = date === e.date ? e.min : 1440;
      if (endMin <= startMin) continue; // ends exactly at midnight: nothing on that day
      const list = perDay.get(date) ?? [];
      list.push({ item, startMin, endMin, fromPrevDay: date !== s.date, toNextDay: date !== e.date });
      perDay.set(date, list);
    }
  }

  return [...perDay.keys()].sort().map((date) => {
    const sorted = perDay.get(date)!.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
    const blocks: Block<T>[] = [];
    let group: Block<T>[] = [];
    let groupEnd = -1;
    const closeGroup = () => {
      const lanes = Math.max(1, ...group.map((b) => b.lane + 1));
      for (const b of group) b.lanes = lanes;
      blocks.push(...group);
      group = [];
    };
    const laneEnds: number[] = []; // end minute of the last block in each lane of the current group
    for (const b of sorted) {
      if (group.length > 0 && b.startMin >= groupEnd) {
        closeGroup();
        laneEnds.length = 0;
      }
      let lane = laneEnds.findIndex((end) => end <= b.startMin);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = b.endMin;
      groupEnd = group.length === 0 ? b.endMin : Math.max(groupEnd, b.endMin);
      group.push({ ...b, lane, lanes: 1 });
    }
    if (group.length > 0) closeGroup();

    let startHour = Math.floor(Math.min(...blocks.map((b) => b.startMin)) / 60);
    let endHour = Math.ceil(Math.max(...blocks.map((b) => b.endMin)) / 60);
    if (endHour - startHour < MIN_AXIS_HOURS) endHour = Math.min(24, startHour + MIN_AXIS_HOURS);
    if (endHour - startHour < MIN_AXIS_HOURS) startHour = Math.max(0, endHour - MIN_AXIS_HOURS);
    return { date, startHour, endHour, blocks };
  });
}
