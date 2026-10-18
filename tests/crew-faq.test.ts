import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { anonymizeUser, exportUserData } from "@/lib/gdpr";
import { createFaqItem, deleteFaqItem, fillPlaceholders, importDefaultFaq, loadCustomFaq, localised, moveFaqItem, updateFaqItem } from "@/lib/content/faq-store";
import { applyToJob, createJob, deleteJob, listManagedJobs, listOpenJobs, localisedJob, setApplicationStatus, updateJob, withdrawApplication } from "@/lib/crew/service";
import { ForbiddenError, UnauthenticatedError } from "@/lib/permissions";
import { setUserTag } from "@/lib/admin/service";
import { crewApplicationSchema, crewJobSchema, faqItemSchema } from "@/lib/validation/crew";
import { asActor, makeUser, resetDb, TEST_PASSWORD } from "./helpers";

beforeEach(resetDb);

const job = (over: Record<string, string> = {}) => crewJobSchema.parse({ title: "Kök", description: "Laga mat", during: "on", isOpen: "on", ...over });
const faq = (over: Record<string, string> = {}) => faqItemSchema.parse({ group: "TICKETS", questionSv: "Fråga?", answerSv: "Svar.", ...over });

describe("FAQ editing", () => {
  it("Festivalledare and Admin may edit; Ansvarig and members may not", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ansvarig = asActor(await makeUser({ tags: ["ANSVARIG"] }));
    const admin = asActor(await makeUser({ tags: ["ADMIN"] }));
    const member = asActor(await makeUser());
    expect((await createFaqItem(fl, faq())).ok).toBe(true);
    expect((await createFaqItem(admin, faq())).ok).toBe(true); // an Admin holds every right
    for (const who of [ansvarig, member]) await expect(createFaqItem(who, faq())).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.faqItem.count()).toBe(2);
  });

  it("creates, updates, deletes and audits", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const r = await createFaqItem(fl, faq(), "1.2.3.4");
    if (!r.ok) throw new Error("create failed");
    expect((await updateFaqItem(fl, r.id, faq({ answerSv: "Nytt svar." }))).ok).toBe(true);
    expect((await db.faqItem.findUniqueOrThrow({ where: { id: r.id } })).answerSv).toBe("Nytt svar.");
    expect(await updateFaqItem(fl, "nope", faq())).toEqual({ ok: false, reason: "notFound" });
    expect((await deleteFaqItem(fl, r.id)).ok).toBe(true);
    expect(await deleteFaqItem(fl, r.id)).toEqual({ ok: false, reason: "notFound" });
    const logs = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["faq.create", "faq.update", "faq.delete"]);
    expect(logs[0]).toMatchObject({ actorId: fl.id, ip: "1.2.3.4" });
  });

  it("new items go last in their group, can be moved, and moving across the ends is a no-op", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ids: string[] = [];
    for (const q of ["A", "B", "C"]) {
      const r = await createFaqItem(fl, faq({ questionSv: q }));
      if (r.ok) ids.push(r.id);
    }
    const order = async () => (await db.faqItem.findMany({ orderBy: { sortOrder: "asc" } })).map((i) => i.questionSv).join("");
    expect(await order()).toBe("ABC");
    await moveFaqItem(fl, ids[2]!, "up");
    expect(await order()).toBe("ACB");
    await moveFaqItem(fl, ids[0]!, "up"); // already first
    await moveFaqItem(fl, ids[1]!, "down"); // already last
    expect(await order()).toBe("ACB");
  });

  it("imports the built-in questions once, and the public page data then comes from the database", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    expect(await loadCustomFaq("sv", { minAge: 14, contact: "x@y.se" })).toBeNull();
    const r = await importDefaultFaq(fl);
    expect(r).toEqual({ ok: true, count: 18 });
    expect(await importDefaultFaq(fl)).toEqual({ ok: false, reason: "alreadyImported" });
    const groups = (await loadCustomFaq("sv", { minAge: 16, contact: "x@y.se" }))!;
    expect(groups.map((g) => g.id)).toEqual(["tickets", "seatsFood", "onSite", "account"]);
    expect(groups.flatMap((g) => g.items)).toHaveLength(18);
    expect(groups[0]!.items[1]!.a).toContain("Åldersgränsen är 16 år"); // placeholder filled in
    const en = (await loadCustomFaq("en", { minAge: 16, contact: "x@y.se" }))!;
    expect(en[0]!.items[1]!.a).toContain("The age limit is 16");
  });

  it("falls back to Swedish when the English text is empty, and fills placeholders", () => {
    const item = { questionSv: "Fråga", answerSv: "Svar", questionEn: "", answerEn: "" };
    expect(localised(item, "en")).toEqual({ q: "Fråga", a: "Svar" });
    expect(localised({ ...item, questionEn: "Q", answerEn: "A" }, "en")).toEqual({ q: "Q", a: "A" });
    expect(fillPlaceholders("{minAge} år, mejla {contact}", { minAge: 14, contact: "a@b.se" })).toBe("14 år, mejla a@b.se");
  });

  it("validates input", () => {
    expect(faqItemSchema.safeParse({ group: "TICKETS", questionSv: "", answerSv: "x" }).success).toBe(false);
    expect(faqItemSchema.safeParse({ group: "NOPE", questionSv: "q", answerSv: "x" }).success).toBe(false);
    expect(faqItemSchema.safeParse({ group: "ON_SITE", questionSv: "q", answerSv: "x" }).success).toBe(true);
  });
});

describe("crew jobs: who may post and edit", () => {
  it("Festivalledare, Ansvarig and Admin may post; members may not", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ansvarig = asActor(await makeUser({ tags: ["ANSVARIG"] }));
    const member = asActor(await makeUser());
    const admin = asActor(await makeUser({ tags: ["ADMIN"] }));
    expect((await createJob(fl, job())).ok).toBe(true);
    expect((await createJob(ansvarig, job())).ok).toBe(true);
    await expect(createJob(member, job())).rejects.toBeInstanceOf(ForbiddenError);
    expect((await createJob(admin, job())).ok).toBe(true);
    await expect(createJob(null as never, job())).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(await db.crewJob.count()).toBe(3);
  });

  it("Ansvarig edits, closes and deletes only their own jobs; Festivalledare manage everything", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const a1 = asActor(await makeUser({ tags: ["ANSVARIG"] }));
    const a2 = asActor(await makeUser({ tags: ["ANSVARIG"] }));
    const mine = await createJob(a1, job({ title: "Mitt" }));
    const theirs = await createJob(a2, job({ title: "Deras" }));
    if (!mine.ok || !theirs.ok) throw new Error();

    expect((await updateJob(a1, mine.id, job({ title: "Mitt 2", isOpen: "" }))).ok).toBe(true);
    expect((await db.crewJob.findUniqueOrThrow({ where: { id: mine.id } })).isOpen).toBe(false);
    await expect(updateJob(a1, theirs.id, job({ title: "Kapad" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteJob(a1, theirs.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await db.crewJob.findUniqueOrThrow({ where: { id: theirs.id } })).title).toBe("Deras");

    expect((await updateJob(fl, theirs.id, job({ title: "Deras 2" }))).ok).toBe(true);
    expect((await deleteJob(fl, mine.id)).ok).toBe(true);
    expect(await updateJob(fl, "nope", job())).toEqual({ ok: false, reason: "notFound" });
    const actions = (await db.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((l) => l.action);
    expect(actions).toEqual(["crew.job.create", "crew.job.create", "crew.job.update", "crew.job.update", "crew.job.delete"]);
  });

  it("the management list shows Ansvarig only their own jobs and Festivalledare all of them", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const a1 = asActor(await makeUser({ tags: ["ANSVARIG"] }));
    const a2 = asActor(await makeUser({ tags: ["ANSVARIG"] }));
    await createJob(a1, job({ title: "Ett" }));
    await createJob(a2, job({ title: "Två" }));
    await createJob(fl, job({ title: "Tre" }));
    expect((await listManagedJobs(a1)).map((j) => j.title)).toEqual(["Ett"]);
    expect((await listManagedJobs(fl)).map((j) => j.title).sort()).toEqual(["Ett", "Tre", "Två"]);
    await expect(listManagedJobs(asActor(await makeUser()))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an Ansvarig who loses the tag can no longer manage their old jobs", async () => {
    const admin = asActor(await makeUser({ tags: ["ADMIN"] }));
    const u = await makeUser({ tags: ["ANSVARIG"] });
    const r = await createJob(asActor(u), job());
    if (!r.ok) throw new Error();
    await setUserTag(admin, u.id, "ANSVARIG", false);
    const after = asActor(await db.user.findUniqueOrThrow({ where: { id: u.id }, include: { tags: true } }));
    await expect(updateJob(after, r.id, job())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Admin can grant the Ansvarig role", async () => {
    const admin = asActor(await makeUser({ tags: ["ADMIN"] }));
    const u = await makeUser();
    expect(await setUserTag(admin, u.id, "ANSVARIG", true)).toEqual({ ok: true, changed: true });
    expect(await db.userTag.count({ where: { userId: u.id, tag: "ANSVARIG" } })).toBe(1);
  });

  it("validates the form: a time of day is required, spots must be a positive number", () => {
    expect(crewJobSchema.safeParse({ title: "x", description: "y" }).success).toBe(false); // no before/during/after
    expect(crewJobSchema.safeParse({ title: "x", description: "y", before: "on", spots: "0" }).success).toBe(false);
    expect(crewJobSchema.safeParse({ title: "x", description: "y", before: "on", spots: "abc" }).success).toBe(false);
    const ok = crewJobSchema.parse({ title: "x", description: "y", after: "on", spots: "4" });
    expect(ok).toMatchObject({ before: false, during: false, after: true, spots: 4, isOpen: false });
    expect(crewJobSchema.parse({ title: "x", description: "y", after: "on" }).spots).toBeNull();
  });

  it("shows English text when present, Swedish otherwise", () => {
    const j = { title: "Kök", description: "Mat", titleEn: "", descriptionEn: "" };
    expect(localisedJob(j, "en")).toEqual({ title: "Kök", description: "Mat" });
    expect(localisedJob({ ...j, titleEn: "Kitchen", descriptionEn: "Food" }, "en")).toEqual({ title: "Kitchen", description: "Food" });
  });
});

describe("crew applications", () => {
  const apply = (jobId: string, over: Record<string, string> = {}) => crewApplicationSchema.parse({ jobId, message: "Jag vill hjälpa till", availability: "Hela helgen", ...over });

  it("a verified member can apply once per job; open jobs only", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const member = asActor(await makeUser());
    const open = await createJob(fl, job());
    const closed = await createJob(fl, job({ isOpen: "" }));
    if (!open.ok || !closed.ok) throw new Error();
    expect(await applyToJob(member, apply(open.id))).toEqual({ ok: true });
    expect(await applyToJob(member, apply(open.id))).toEqual({ ok: false, reason: "duplicate" });
    expect(await applyToJob(member, apply(closed.id))).toEqual({ ok: false, reason: "closed" });
    expect(await applyToJob(member, apply("nope"))).toEqual({ ok: false, reason: "notFound" });
    expect(await db.crewApplication.count()).toBe(1);
    expect((await listOpenJobs()).map((j) => j.id)).toEqual([open.id]);
  });

  it("unverified users and visitors cannot apply", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const unverified = asActor(await makeUser({ verified: false }));
    const j = await createJob(fl, job());
    if (!j.ok) throw new Error();
    await expect(applyToJob(unverified, apply(j.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(applyToJob(null as never, apply(j.id))).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("validates the application", () => {
    expect(crewApplicationSchema.safeParse({ jobId: "j", message: "", availability: "x" }).success).toBe(false);
    expect(crewApplicationSchema.safeParse({ jobId: "j", message: "x", availability: "" }).success).toBe(false);
    expect(crewApplicationSchema.safeParse({ jobId: "j", message: "x".repeat(1501), availability: "x" }).success).toBe(false);
  });

  it("only the job's owner (or a Festivalledare) can review applications", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const owner = asActor(await makeUser({ tags: ["ANSVARIG"] }));
    const other = asActor(await makeUser({ tags: ["ANSVARIG"] }));
    const member = asActor(await makeUser());
    const j = await createJob(owner, job());
    if (!j.ok) throw new Error();
    await applyToJob(member, apply(j.id));
    const app = await db.crewApplication.findFirstOrThrow();

    await expect(setApplicationStatus(other, app.id, "ACCEPTED")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setApplicationStatus(member, app.id, "ACCEPTED")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listManagedJobs(other)).flatMap((x) => x.applications)).toHaveLength(0);
    expect((await listManagedJobs(owner))[0]!.applications).toHaveLength(1);

    expect((await setApplicationStatus(owner, app.id, "ACCEPTED")).ok).toBe(true);
    expect((await db.crewApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("ACCEPTED");
    expect((await setApplicationStatus(fl, app.id, "DECLINED")).ok).toBe(true);
    expect(await setApplicationStatus(fl, "nope", "NEW")).toEqual({ ok: false, reason: "notFound" });
  });

  it("applicants can withdraw; deleting a job removes its applications; the audit log holds no free text", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const member = asActor(await makeUser());
    const j = await createJob(fl, job());
    if (!j.ok) throw new Error();
    await applyToJob(member, apply(j.id, { message: "hemlig text" }));
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain("hemlig text");
    expect((await withdrawApplication(member, j.id)).ok).toBe(true);
    expect(await withdrawApplication(member, j.id)).toEqual({ ok: false, reason: "notFound" });
    await applyToJob(member, apply(j.id));
    await deleteJob(fl, j.id);
    expect(await db.crewApplication.count()).toBe(0);
  });

  it("GDPR: applications are in the data export and erased when the account is anonymised", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const u = await makeUser();
    const j = await createJob(fl, job());
    if (!j.ok) throw new Error();
    await applyToJob(asActor(u), apply(j.id, { message: "min motivering" }));
    const exported = await exportUserData(u.id);
    expect(JSON.stringify(exported)).toContain("min motivering");
    expect(await anonymizeUser(u.id, { password: TEST_PASSWORD })).toEqual({ ok: true });
    expect(await db.crewApplication.count()).toBe(0);
  });
});
