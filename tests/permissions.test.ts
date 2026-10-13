import { describe, expect, it } from "vitest";
import { ACTIONS, assertCan, can, ForbiddenError, UnauthenticatedError, type Action, type Actor } from "@/lib/permissions";

const verified = new Date();
type Role = "visitor" | "unverified" | "member" | "festivalledare" | "admin" | "both";
const actors: Record<Role, Actor | null> = {
  visitor: null,
  unverified: { id: "u-unverified", emailVerifiedAt: null, tags: [] },
  member: { id: "u-member", emailVerifiedAt: verified, tags: [] },
  festivalledare: { id: "u-fl", emailVerifiedAt: verified, tags: ["FESTIVALLEDARE"] },
  admin: { id: "u-admin", emailVerifiedAt: verified, tags: ["ADMIN"] },
  both: { id: "u-both", emailVerifiedAt: verified, tags: ["ADMIN", "FESTIVALLEDARE"] },
};


// Role × action matrix with no resource (i.e. "may this role ever do this at all").
// Actions that depend on ownership are tested separately below; here self/owner actions use the actor's own id.
const allow: Record<Action, Role[]> = {
  "event:view": ["visitor", "unverified", "member", "festivalledare", "admin", "both"],
  "chart:view": ["visitor", "unverified", "member", "festivalledare", "admin", "both"],
  "profile:edit": ["unverified", "member", "festivalledare", "admin", "both"],
  "account:export": ["unverified", "member", "festivalledare", "admin", "both"],
  "account:delete": ["unverified", "member", "festivalledare", "admin", "both"],
  "ticket:buy": ["member", "festivalledare", "admin", "both"],
  "food:buy": ["member", "festivalledare", "admin", "both"],
  "seat:choose": ["member", "festivalledare", "admin", "both"],
  "order:view": ["festivalledare", "both"], // others only for their own (tested below)
  "ticket:view": ["festivalledare", "both"],
  "event:manage": ["festivalledare", "both"],
  "ticketType:manage": ["festivalledare", "both"],
  "chart:manage": ["festivalledare", "both"],
  "template:manage": ["festivalledare", "both"],
  "foodPackage:manage": ["festivalledare", "both"],
  "discountCode:manage": ["festivalledare", "both"],
  "attendees:view": ["festivalledare", "both"],
  "sales:view": ["festivalledare", "both"],
  "kitchen:view": ["festivalledare", "both"],
  "checkin:perform": ["festivalledare", "both"],
  "order:cancel": ["festivalledare", "both"],
  "order:refund": ["festivalledare", "both"],
  "broadcast:send": ["festivalledare", "both"],
  "user:manage": ["admin", "both"],
  "userTag:manage": ["admin", "both"],
  "orgSettings:edit": ["admin", "both"],
  "audit:view": ["admin", "both"],
};

describe("permission matrix (role × action)", () => {
  it("covers every declared action", () => {
    expect(Object.keys(allow).sort()).toEqual(Object.keys(ACTIONS).sort());
  });

  for (const action of Object.keys(ACTIONS) as Action[]) {
    for (const role of Object.keys(actors) as Role[]) {
      const expected = allow[action].includes(role);
      it(`${role} ${expected ? "CAN" : "cannot"} ${action}`, () => {
        const actor = actors[role] ?? null;
        // Self-scoped actions are evaluated against the actor's own resource.
        const resource = actor ? { ownerId: ["profile:edit", "account:export", "account:delete"].includes(action) ? actor.id : undefined } : {};
        expect(can(actor, action, resource)).toBe(expected);
      });
    }
  }
});

describe("ownership rules", () => {
  const member = actors.member as Actor;
  const other = actors.unverified as Actor;

  it("members can view only their own orders and tickets", () => {
    expect(can(member, "order:view", { ownerId: member.id })).toBe(true);
    expect(can(member, "order:view", { ownerId: other.id })).toBe(false);
    expect(can(member, "ticket:view", { ownerId: other.id })).toBe(false);
  });

  it("Festivalledare can view anyone's orders", () => {
    expect(can(actors.festivalledare, "order:view", { ownerId: other.id })).toBe(true);
  });

  it("nobody can edit, export or delete someone else's account (even Admin)", () => {
    for (const action of ["profile:edit", "account:export", "account:delete"] as const) {
      expect(can(actors.admin, action, { ownerId: member.id })).toBe(false);
      expect(can(actors.festivalledare, action, { ownerId: member.id })).toBe(false);
    }
  });

  it("visitors can't view orders", () => {
    expect(can(null, "order:view", { ownerId: "x" })).toBe(false);
  });
});

describe("draft events", () => {
  it("are visible to Festivalledare and Admin only", () => {
    const r = { eventStatus: "DRAFT" } as const;
    expect(can(null, "event:view", r)).toBe(false);
    expect(can(actors.member, "event:view", r)).toBe(false);
    expect(can(actors.festivalledare, "event:view", r)).toBe(true);
    expect(can(actors.admin, "event:view", r)).toBe(true);
  });

  it("published, closed and cancelled events are public", () => {
    for (const eventStatus of ["PUBLISHED", "CLOSED", "CANCELLED"] as const) {
      expect(can(null, "event:view", { eventStatus })).toBe(true);
    }
  });
});

describe("assertCan", () => {
  it("throws Unauthenticated for visitors and Forbidden for logged-in users", () => {
    expect(() => assertCan(null, "user:manage")).toThrow(UnauthenticatedError);
    expect(() => assertCan(actors.member, "user:manage")).toThrow(ForbiddenError);
    expect(() => assertCan(actors.admin, "user:manage")).not.toThrow();
  });
});
