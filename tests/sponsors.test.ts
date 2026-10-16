import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ForbiddenError } from "@/lib/permissions";
import { createSponsor, deleteSponsor, groupByTier, listSponsors, updateSponsor } from "@/lib/sponsors/service";
import { LocalDiskStorage, setStorage } from "@/lib/storage";
import { sponsorSchema } from "@/lib/validation/crew";
import { asActor, makeUser, resetDb } from "./helpers";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const input = (over: Record<string, string> = {}) => sponsorSchema.parse({ name: "Kabelfabriken", tier: "REGULAR", isActive: "on", ...over });

let dir: string;
const files = async () => (await readdir(path.join(dir, "sponsors")).catch(() => [])).sort();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ccss-sponsors-"));
  setStorage(new LocalDiskStorage(dir));
});
afterAll(async () => {
  setStorage(undefined);
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb();
  await rm(path.join(dir, "sponsors"), { recursive: true, force: true });
});

describe("sponsors", () => {
  it("only Festivalledare manage sponsors", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    expect((await createSponsor(fl, input(), png)).ok).toBe(true);
    for (const tags of [["ANSVARIG"], ["ADMIN"], []] as const) {
      const who = asActor(await makeUser({ tags: [...tags] }));
      await expect(createSponsor(who, input(), png)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await db.sponsor.count()).toBe(1);
  });

  it("stores the logo, audits, and replaces or removes the file when the sponsor changes", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const r = await createSponsor(fl, input(), png, "1.2.3.4");
    if (!r.ok) throw new Error();
    const first = await db.sponsor.findUniqueOrThrow({ where: { id: r.id } });
    expect(first.logoPath).toMatch(/^\/uploads\/sponsors\/[a-f0-9]{32}\.png$/);
    expect(await files()).toHaveLength(1);

    expect((await updateSponsor(fl, r.id, input({ name: "Nytt namn", tier: "MAIN" }))).ok).toBe(true); // no new logo: file stays
    expect((await db.sponsor.findUniqueOrThrow({ where: { id: r.id } })).logoPath).toBe(first.logoPath);
    expect(await files()).toHaveLength(1);

    expect((await updateSponsor(fl, r.id, input(), jpg)).ok).toBe(true); // new logo: old file removed
    const second = await db.sponsor.findUniqueOrThrow({ where: { id: r.id } });
    expect(second.logoPath).toMatch(/\.jpg$/);
    expect(await files()).toHaveLength(1);

    expect((await deleteSponsor(fl, r.id)).ok).toBe(true);
    expect(await files()).toHaveLength(0);
    expect(await deleteSponsor(fl, r.id)).toEqual({ ok: false, reason: "notFound" });
    expect(await updateSponsor(fl, r.id, input())).toEqual({ ok: false, reason: "notFound" });
    const logs = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["sponsor.create", "sponsor.update", "sponsor.update", "sponsor.delete"]);
    expect(logs[0]).toMatchObject({ actorId: fl.id, ip: "1.2.3.4" });
  });

  it("refuses files that are not images or too large, and creates nothing", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    expect(await createSponsor(fl, input(), Buffer.from("<svg onload=alert(1)>"))).toEqual({ ok: false, reason: "badImage" });
    expect(await createSponsor(fl, input(), Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]))).toEqual({ ok: false, reason: "tooLarge" });
    expect(await db.sponsor.count()).toBe(0);
    expect(await files()).toHaveLength(0);
  });

  it("lists huvudsponsor first, then stor sponsor, then sponsor, each in its chosen order; inactive ones stay off the public list", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    await createSponsor(fl, input({ name: "C", tier: "REGULAR", sortOrder: "1" }), png);
    await createSponsor(fl, input({ name: "B", tier: "LARGE" }), png);
    await createSponsor(fl, input({ name: "A2", tier: "MAIN", sortOrder: "2" }), png);
    await createSponsor(fl, input({ name: "A1", tier: "MAIN", sortOrder: "1" }), png);
    await createSponsor(fl, sponsorSchema.parse({ name: "Dold", tier: "MAIN" }), png); // isActive unchecked
    expect((await listSponsors()).map((s) => s.name)).toEqual(["Dold", "A1", "A2", "B", "C"]);
    const pub = groupByTier(await listSponsors({ onlyActive: true }));
    expect(pub.map((g) => [g.tier, g.sponsors.map((s) => s.name)])).toEqual([["MAIN", ["A1", "A2"]], ["LARGE", ["B"]], ["REGULAR", ["C"]]]);
  });

  it("validates the form: a name, a tier and an http(s) link only", () => {
    expect(sponsorSchema.safeParse({ name: "", tier: "MAIN" }).success).toBe(false);
    expect(sponsorSchema.safeParse({ name: "x", tier: "GOLD" }).success).toBe(false);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.se", "not a url"]) expect(sponsorSchema.safeParse({ name: "x", tier: "MAIN", url: bad }).success).toBe(false);
    expect(sponsorSchema.parse({ name: "x", tier: "MAIN", url: "https://kabel.se/" }).url).toBe("https://kabel.se/");
    expect(sponsorSchema.parse({ name: "x", tier: "MAIN" }).url).toBeNull();
  });
});
