/**
 * The colours a schedule category can have. Free colour pickers would let a Festivalledare pick text that cannot
 * be read, so each key carries a background AND the text colour that goes with it (all pairs are >= 5.5:1).
 * Colour is never the only signal: blocks always show the category name as text too.
 */
export const SCHEDULE_COLORS = {
  hay: { bg: "#E9B73A", fg: "#14211A" },
  sage: { bg: "#8FB59C", fg: "#14211A" },
  sky: { bg: "#56B4E9", fg: "#14211A" },
  pink: { bg: "#F4A6B8", fg: "#14211A" },
  orange: { bg: "#F0A04B", fg: "#14211A" },
  barn: { bg: "#B83A24", fg: "#FFFFFF" },
  teal: { bg: "#0F766E", fg: "#FFFFFF" },
  plum: { bg: "#6B3FA0", fg: "#FFFFFF" },
  night: { bg: "#17342A", fg: "#FFFFFF" },
  slate: { bg: "#4D5B50", fg: "#FFFFFF" },
} as const;

export type ScheduleColor = keyof typeof SCHEDULE_COLORS;
export const SCHEDULE_COLOR_KEYS = Object.keys(SCHEDULE_COLORS) as [ScheduleColor, ...ScheduleColor[]];

/** Blocks without a category. */
export const NO_CATEGORY_STYLE = { bg: "#F2EAD6", fg: "#14211A" } as const;

export const colorOf = (key: string | null | undefined) => (key && key in SCHEDULE_COLORS ? SCHEDULE_COLORS[key as ScheduleColor] : NO_CATEGORY_STYLE);
