import type { EventStatus, UserTagKind } from "@prisma/client";

/**
 * Every permission rule lives here. Server Actions and route handlers call
 * can() / assertCan(); hiding things in the UI is only cosmetic.
 *
 * Roles:
 *  - visitor: user === null
 *  - member:  logged in. Buying / choosing seats additionally needs a verified email.
 *  - FESTIVALLEDARE tag: all member abilities + all event management.
 *  - ANSVARIG tag: may post crew jobs and manage (edit, close, review applications for) their OWN jobs.
 *    Festivalledare manage all crew jobs and the FAQ.
 *  - ADMIN tag: user and org management AND every other right: an admin is treated as holding the
 *    FESTIVALLEDARE and ANSVARIG tags too (see effectiveTags), whether or not they have been granted.
 */

export interface Actor {
  id: string;
  emailVerifiedAt: Date | null;
  tags: readonly UserTagKind[];
}

export interface Resource {
  /** Owner of the thing being accessed (order, ticket, profile ...). */
  ownerId?: string;
  /** Status of the event the thing belongs to. */
  eventStatus?: EventStatus;
}

export const ACTIONS = {
  // Public (visitor)
  "event:view": "public",
  "chart:view": "public",
  // Member
  "profile:edit": "self",
  "account:export": "self",
  "account:delete": "self",
  "ticket:buy": "verifiedMember",
  "food:buy": "verifiedMember",
  "seat:choose": "verifiedMember",
  "crewApplication:create": "verifiedMember",
  "order:view": "ownerOrStaff",
  "ticket:view": "ownerOrStaff",
  // Festivalledare
  "event:manage": "festivalledare",
  "ticketType:manage": "festivalledare",
  "chart:manage": "festivalledare",
  "template:manage": "festivalledare",
  "foodPackage:manage": "festivalledare",
  "discountCode:manage": "festivalledare",
  "attendees:view": "festivalledare",
  "sales:view": "festivalledare",
  "kitchen:view": "festivalledare",
  "checkin:perform": "festivalledare",
  "order:cancel": "festivalledare",
  "order:refund": "festivalledare",
  "broadcast:send": "festivalledare",
  "faq:manage": "festivalledare",
  "sponsor:manage": "festivalledare",
  "team:create": "verifiedMember", // create a team (the creator becomes its captain); captain actions are checked per team in the service
  "team:moderate": "festivalledare", // disband any team, remove any registration
  "tournament:manage": "festivalledare",
  "schedule:manage": "festivalledare", // the event programme: categories and blocks
  "news:manage": "festivalledare", // write, publish and delete news posts (drafts are visible to them too)
  "association:manage": "festivalledare", // intro, board members and documents on the association page
  // Crew jobs: Ansvarig may create and then manage their own; Festivalledare manage all
  "crewJob:create": "crewStaff",
  "crewJob:edit": "crewOwnerOrLeader", // resource.ownerId = the job's creator; also covers viewing its applications
  // Admin
  "user:manage": "admin",
  "userTag:manage": "admin",
  "orgSettings:edit": "admin",
  "audit:view": "admin",
} as const satisfies Record<string, Rule>;

type Rule = "public" | "self" | "verifiedMember" | "ownerOrStaff" | "festivalledare" | "crewStaff" | "crewOwnerOrLeader" | "admin";

export type Action = keyof typeof ACTIONS;

/** The tags that count when checking rights: an ADMIN also holds FESTIVALLEDARE and ANSVARIG. */
export function effectiveTags(u: { tags: readonly UserTagKind[] }): readonly UserTagKind[] {
  return u.tags.includes("ADMIN") ? [...new Set<UserTagKind>([...u.tags, "FESTIVALLEDARE", "ANSVARIG"])] : u.tags;
}

const has = (u: Actor, tag: UserTagKind) => effectiveTags(u).includes(tag);

export function can(user: Actor | null, action: Action, resource: Resource = {}): boolean {
  const rule: Rule = ACTIONS[action];
  switch (rule) {
    case "public":
      if (action === "event:view" && resource.eventStatus === "DRAFT") {
        return !!user && (has(user, "FESTIVALLEDARE") || has(user, "ADMIN"));
      }
      return true;
    case "self":
      return !!user && (resource.ownerId === undefined || resource.ownerId === user.id);
    case "verifiedMember":
      return !!user && user.emailVerifiedAt !== null;
    case "ownerOrStaff":
      return !!user && (has(user, "FESTIVALLEDARE") || resource.ownerId === user.id);
    case "festivalledare":
      return !!user && has(user, "FESTIVALLEDARE");
    case "crewStaff":
      return !!user && (has(user, "FESTIVALLEDARE") || has(user, "ANSVARIG"));
    case "crewOwnerOrLeader":
      return !!user && (has(user, "FESTIVALLEDARE") || (has(user, "ANSVARIG") && resource.ownerId !== undefined && resource.ownerId === user.id));
    case "admin":
      return !!user && has(user, "ADMIN");
  }
}

export class ForbiddenError extends Error {
  constructor(public action: Action) {
    super(`Forbidden: ${action}`);
    this.name = "ForbiddenError";
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

/** Throws if not allowed. Narrows `user` to non-null for actions that need a login. */
export function assertCan<U extends Actor>(user: U | null, action: Action, resource: Resource = {}): asserts user is U {
  if (!can(user, action, resource)) {
    if (!user) throw new UnauthenticatedError();
    throw new ForbiddenError(action);
  }
}
