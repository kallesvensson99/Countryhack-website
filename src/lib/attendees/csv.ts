/**
 * CSV for Excel.
 *  - UTF-8 with a BOM, so Excel reads åäö correctly.
 *  - Default delimiter ";" — Swedish Excel uses ";" as list separator and would put a comma-separated file in one column.
 *  - Cells that start with = + - @ (or tab / CR) are prefixed with an apostrophe so a spreadsheet can't run them as formulas
 *    (names, nicknames and allergy texts are user-controlled). Plain phone-like values (digits, spaces, + ( ) -) are left alone.
 */
export type Delimiter = ";" | ",";

export const BOM = "﻿";

const PHONE_LIKE = /^\+?[\d\s()-]+$/;

export function neutralize(cell: string): string {
  if (/^[=+\-@\t\r]/.test(cell) && !PHONE_LIKE.test(cell)) return `'${cell}`;
  return cell;
}

export function csvCell(value: string | number | boolean | null | undefined, delimiter: Delimiter): string {
  const s = neutralize(value === null || value === undefined ? "" : String(value));
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | boolean | null | undefined)[][], delimiter: Delimiter = ";"): string {
  return BOM + rows.map((r) => r.map((c) => csvCell(c, delimiter)).join(delimiter)).join("\r\n") + "\r\n";
}
