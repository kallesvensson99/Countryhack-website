import type { ChartObjectKind } from "@prisma/client";
import { isLightColor } from "@/lib/seating/geometry";
import { SEAT_SIZE, type ObjectData, type SeatState } from "@/lib/seating/types";

/**
 * Seat glyphs. State is conveyed by SHAPE / PATTERN, never by colour alone (colour only identifies the zone):
 *   free      zone colour, solid outline
 *   mine      zone colour, heavy outline + white star badge
 *   taken     dark grey with a white ✕
 *   blocked   diagonal hatch, dashed outline
 *   reserved  white with a dashed outline and an "R"
 */

const H = SEAT_SIZE / 2;

export function SeatDefs({ id = "seat-hatch" }: { id?: string }) {
  return (
    <defs>
      <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="#f2ead6" />
        <rect width="3" height="6" fill="#6f8a78" />
      </pattern>
    </defs>
  );
}

export function SeatShape({
  state,
  color,
  label,
  rotation = 0,
  dim = false,
  selected = false,
  showLabel = true,
  patternId = "seat-hatch",
}: {
  state: SeatState;
  color: string;
  label: string;
  rotation?: number;
  dim?: boolean;
  selected?: boolean;
  showLabel?: boolean;
  patternId?: string;
}) {
  const textFill = state === "free" || state === "mine" ? (isLightColor(color) ? "#111827" : "#ffffff") : "#111827";
  return (
    <g opacity={dim ? 0.4 : 1}>
      <g transform={`rotate(${rotation})`}>
        {state === "free" && <circle r={H} fill={color} stroke="#14211a" strokeWidth={1.5} />}
        {state === "mine" && <><circle r={H + 3} fill="none" stroke="#e9b73a" strokeWidth={3} /><circle r={H} fill={color} stroke="#14211a" strokeWidth={2} /></>}
        {state === "taken" && (
          <>
            <circle r={H} fill="#2f4a3b" stroke="#8fb59c" strokeWidth={1.5} />
            <path d={`M${-H + 6} ${-H + 6}L${H - 6} ${H - 6}M${H - 6} ${-H + 6}L${-H + 6} ${H - 6}`} stroke="#f2ead6" strokeWidth={2.5} strokeLinecap="round" />
          </>
        )}
        {state === "blocked" && <circle r={H} fill={`url(#${patternId})`} stroke="#6f8a78" strokeWidth={1.5} strokeDasharray="4 3" />}
        {state === "reserved" && <circle r={H} fill="#f2ead6" stroke="#14211a" strokeWidth={2} strokeDasharray="4 3" />}
        {/* back-rest tick: shows which way the seat faces (rotation) */}
        <rect x={-6} y={-H - 4} width={12} height={3} rx={1} fill="#f2ead6" stroke="#14211a" strokeWidth={0.75} />
        {selected && <rect x={-H - 4} y={-H - 4} width={SEAT_SIZE + 8} height={SEAT_SIZE + 8} rx={SEAT_SIZE} fill="none" stroke="#e9b73a" strokeWidth={3} />}
      </g>
      {state === "mine" && <path d="M8 -15l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z" fill="#ffffff" stroke="#111827" strokeWidth={1.2} />}
      {state === "reserved" && (
        <text textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={700} fill="#111827" pointerEvents="none">
          R
        </text>
      )}
      {showLabel && state !== "taken" && state !== "reserved" && state !== "mine" && (
        <text textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={600} fill={textFill} pointerEvents="none">
          {label}
        </text>
      )}
      {showLabel && state === "mine" && (
        <text y={4} textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill={textFill} pointerEvents="none">
          {label}
        </text>
      )}
    </g>
  );
}

const OBJECT_STYLE: Record<ChartObjectKind, { fill: string; stroke: string; text: string }> = {
  TABLE: { fill: "#f2ead6", stroke: "#14211a", text: "#14211a" },
  STAGE: { fill: "#17342a", stroke: "#f2ead6", text: "#f2ead6" },
  ENTRANCE: { fill: "#0f2118", stroke: "#8fb59c", text: "#8fb59c" },
  KITCHEN: { fill: "#0f2118", stroke: "#e9b73a", text: "#e9b73a" },
  TOILET: { fill: "#0f2118", stroke: "#8fb59c", text: "#8fb59c" },
  WALL: { fill: "#4d5b50", stroke: "#14211a", text: "#f2ead6" },
  LABEL: { fill: "transparent", stroke: "transparent", text: "#f2ead6" },
};

export function ObjectShape({ o, kindLabels, selected = false, tone = "dark" }: { o: ObjectData; kindLabels: Record<string, string>; selected?: boolean; tone?: "dark" | "light" }) {
  const st = OBJECT_STYLE[o.kind];
  const text = o.label || (o.kind === "WALL" || o.kind === "TABLE" ? "" : (kindLabels[o.kind] ?? o.kind));
  return (
    <g transform={`rotate(${o.rotation} ${o.x + o.width / 2} ${o.y + o.height / 2})`}>
      <rect x={o.x} y={o.y} width={o.width} height={o.height} rx={o.kind === "WALL" ? 1 : 6} fill={st.fill} stroke={selected ? "#e9b73a" : st.stroke} strokeWidth={selected ? 3 : 2} strokeDasharray={(o.kind === "ENTRANCE" || o.kind === "KITCHEN" || o.kind === "TOILET") && !selected ? "6 4" : o.kind === "LABEL" && selected ? "4 3" : undefined} />
      {text && (
        <text x={o.x + o.width / 2} y={o.y + o.height / 2} textAnchor="middle" dominantBaseline="central" fontSize={o.kind === "LABEL" ? 14 : 12} fontWeight={700} fontFamily="IBM Plex Mono, monospace" fill={o.kind === "LABEL" && tone === "light" ? "#14211a" : st.text} pointerEvents="none">
          {text}
        </text>
      )}
    </g>
  );
}

/** One legend row: a glyph sample + its meaning. */
export function LegendItem({ state, color, text, dim }: { state: SeatState; color: string; text: string; dim?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <svg width={34} height={34} viewBox="-17 -17 34 34" aria-hidden="true">
        {state === "blocked" && <SeatDefs id="legend-hatch" />}
        <SeatShape state={state} color={color} label="" showLabel={false} dim={dim} patternId="legend-hatch" />
      </svg>
      <span>{text}</span>
    </li>
  );
}
