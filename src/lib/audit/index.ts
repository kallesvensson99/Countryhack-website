import type { Prisma } from "@prisma/client";
import { db } from "../db";

type Client = Prisma.TransactionClient | typeof db;

export interface AuditEntry {
  actorId: string | null;
  action: string; // e.g. "user.tag.add", "org.settings.update"
  entityType: string;
  entityId: string;
  eventId?: string | null;
  diff: Prisma.InputJsonValue;
  ip?: string | null;
}

/** Pass the transaction client so the audit row commits atomically with the change. */
export async function writeAudit(client: Client, entry: AuditEntry): Promise<void> {
  await client.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      eventId: entry.eventId ?? null,
      diff: entry.diff,
      ip: entry.ip ?? null,
    },
  });
}

const SENSITIVE = new Set(["passwordHash", "tokenHash"]);

/**
 * Field-level diff of two plain objects: { field: { from, to } } for changed fields only.
 * Sensitive fields are reported as changed without their values.
 */
export function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields?: readonly string[],
): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue> = {};
  for (const key of fields ?? new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = norm(before[key]);
    const b = norm(after[key]);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[key] = SENSITIVE.has(key) ? { from: "[redacted]", to: "[redacted]" } : { from: (a ?? null) as Prisma.InputJsonValue, to: (b ?? null) as Prisma.InputJsonValue };
    }
  }
  return out;
}

function norm(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}
