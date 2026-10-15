import type { CrewApplicationStatus, CrewJob } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { can, assertCan, type Actor } from "../permissions";
import type { CrewApplicationInput, CrewJobInput } from "../validation/crew";
import sv from "../../../messages/sv.json";
import en from "../../../messages/en.json";

type Fail<R extends string> = { ok: false; reason: R };
const JOB_FIELDS = ["title", "description", "titleEn", "descriptionEn", "before", "during", "after", "spots", "isOpen"] as const;

/** Job text in the reader's language; an empty English text falls back to Swedish. */
export function localisedJob(job: Pick<CrewJob, "title" | "description" | "titleEn" | "descriptionEn">, locale: string) {
  const en = locale === "en";
  return { title: (en && job.titleEn) || job.title, description: (en && job.descriptionEn) || job.description };
}

/** Public: jobs people can apply to now. */
export async function listOpenJobs() {
  return db.crewJob.findMany({ where: { isOpen: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

/** Management list: Festivalledare see every job, Ansvarig only the ones they posted. */
export async function listManagedJobs(actor: Actor) {
  assertCan(actor, "crewJob:create");
  const all = can(actor, "crewJob:edit", {}); // true only for Festivalledare
  return db.crewJob.findMany({
    where: all ? {} : { createdById: actor.id },
    orderBy: [{ isOpen: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
    include: {
      createdBy: { select: { nickname: true } },
      applications: { orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, realName: true, nickname: true, email: true, phone: true, birthDate: true, anonymizedAt: true } } } },
    },
  });
}

export async function createJob(actor: Actor, input: CrewJobInput, ip?: string | null): Promise<{ ok: true; id: string }> {
  assertCan(actor, "crewJob:create");
  return db.$transaction(async (tx) => {
    const job = await tx.crewJob.create({ data: { ...input, createdById: actor.id } });
    await writeAudit(tx, { actorId: actor.id, action: "crew.job.create", entityType: "CrewJob", entityId: job.id, diff: { title: { from: null, to: job.title } }, ip });
    return { ok: true as const, id: job.id };
  });
}

export async function updateJob(actor: Actor, id: string, input: CrewJobInput, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  return db.$transaction(async (tx) => {
    const before = await tx.crewJob.findUnique({ where: { id } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    assertCan(actor, "crewJob:edit", { ownerId: before.createdById ?? undefined });
    const after = await tx.crewJob.update({ where: { id }, data: input });
    await writeAudit(tx, { actorId: actor.id, action: "crew.job.update", entityType: "CrewJob", entityId: id, diff: diffObjects(before, after, JOB_FIELDS), ip });
    return { ok: true as const };
  });
}

export async function deleteJob(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  return db.$transaction(async (tx) => {
    const before = await tx.crewJob.findUnique({ where: { id }, include: { _count: { select: { applications: true } } } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    assertCan(actor, "crewJob:edit", { ownerId: before.createdById ?? undefined });
    await tx.crewJob.delete({ where: { id } }); // applications go with it
    await writeAudit(tx, { actorId: actor.id, action: "crew.job.delete", entityType: "CrewJob", entityId: id, diff: { title: { from: before.title, to: null }, applications: { from: before._count.applications, to: 0 } }, ip });
    return { ok: true as const };
  });
}

export async function setApplicationStatus(actor: Actor, applicationId: string, status: CrewApplicationStatus, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  return db.$transaction(async (tx) => {
    const app = await tx.crewApplication.findUnique({ where: { id: applicationId }, include: { job: true } });
    if (!app) return { ok: false as const, reason: "notFound" as const };
    assertCan(actor, "crewJob:edit", { ownerId: app.job.createdById ?? undefined });
    if (app.status !== status) {
      await tx.crewApplication.update({ where: { id: applicationId }, data: { status } });
      await writeAudit(tx, { actorId: actor.id, action: "crew.application.status", entityType: "CrewApplication", entityId: applicationId, diff: { status: { from: app.status, to: status } }, ip });
    }
    return { ok: true as const };
  });
}

export type ApplyResult = { ok: true } | Fail<"notFound" | "closed" | "duplicate">;

/** Apply to an open job. One application per person and job. */
export async function applyToJob(user: Actor, input: CrewApplicationInput, ip?: string | null): Promise<ApplyResult> {
  assertCan(user, "crewApplication:create");
  const job = await db.crewJob.findUnique({ where: { id: input.jobId } });
  if (!job) return { ok: false, reason: "notFound" };
  if (!job.isOpen) return { ok: false, reason: "closed" };
  try {
    await db.$transaction(async (tx) => {
      const app = await tx.crewApplication.create({ data: { jobId: job.id, userId: user.id, message: input.message, availability: input.availability } });
      // No free text in the audit log: it is personal data that must be erasable.
      await writeAudit(tx, { actorId: user.id, action: "crew.application.create", entityType: "CrewApplication", entityId: app.id, diff: { jobId: { from: null, to: job.id } }, ip });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "duplicate" };
    throw e;
  }
  return { ok: true };
}

export async function withdrawApplication(user: Actor, jobId: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(user, "crewApplication:create");
  return db.$transaction(async (tx) => {
    const app = await tx.crewApplication.findUnique({ where: { jobId_userId: { jobId, userId: user.id } } });
    if (!app) return { ok: false as const, reason: "notFound" as const };
    await tx.crewApplication.delete({ where: { id: app.id } });
    await writeAudit(tx, { actorId: user.id, action: "crew.application.withdraw", entityType: "CrewApplication", entityId: app.id, diff: { jobId: { from: jobId, to: null } }, ip });
    return { ok: true as const };
  });
}

/** What the signed-in user has already applied to (job id -> status). */
export async function myApplications(userId: string) {
  const rows = await db.crewApplication.findMany({ where: { userId }, select: { jobId: true, status: true } });
  return new Map(rows.map((r) => [r.jobId, r.status] as const));
}

/** The jobs the crew page started with (from the translation files); the seed copies them into the database so they can be edited. */
const DEFAULT_WHEN = { checkin: [false, true, false], kitchen: [true, true, false], tech: [true, true, true], hosts: [false, true, false], build: [true, false, true] } as const;
export const DEFAULT_JOBS = (Object.keys(DEFAULT_WHEN) as (keyof typeof DEFAULT_WHEN)[]).map((id) => {
  const svT = sv.crew as Record<string, string>;
  const enT = en.crew as Record<string, string>;
  const [before, during, after] = DEFAULT_WHEN[id];
  return { title: svT[`role_${id}_title`]!, description: svT[`role_${id}_desc`]!, titleEn: enT[`role_${id}_title`] ?? "", descriptionEn: enT[`role_${id}_desc`] ?? "", before, during, after };
});
