import { db } from "../db";
import { assertCan, type Actor } from "../permissions";

export interface KitchenMeal {
  id: string;
  name: string;
  servedAt: Date;
  total: number;
  variants: { name: string; count: number }[];
}

export interface KitchenAllergy {
  nickname: string;
  realName: string;
  allergies: string | null;
  dietary: string | null;
  packages: string[];
}

export interface KitchenSummary {
  meals: KitchenMeal[];
  allergies: KitchenAllergy[];
  purchases: number;
}

/**
 * What the kitchen needs: servings per meal and variant (ACTIVE purchases only), and who has allergies,
 * by name. The allergy text is the snapshot taken at purchase time; later profile edits don't change it.
 */
export async function kitchenSummary(actor: Actor, eventId: string): Promise<KitchenSummary> {
  assertCan(actor, "kitchen:view");
  const purchases = await db.foodPurchase.findMany({
    where: { status: "ACTIVE", ticket: { eventId } },
    include: { variant: true, package: { include: { meals: { include: { meal: true } } } }, ticket: { include: { user: { select: { nickname: true, realName: true, dietaryPreferences: true } } } } },
  });
  const meals = await db.meal.findMany({ where: { eventId }, orderBy: { servedAt: "asc" } });

  const perMeal = new Map<string, Map<string, number>>();
  for (const p of purchases) {
    for (const m of p.package.meals) {
      const variants = perMeal.get(m.mealId) ?? new Map<string, number>();
      variants.set(p.variant.name, (variants.get(p.variant.name) ?? 0) + 1);
      perMeal.set(m.mealId, variants);
    }
  }

  const byUser = new Map<string, KitchenAllergy>();
  for (const p of purchases) {
    const allergies = p.allergiesSnapshot?.trim() || null;
    const dietary = p.ticket.user.dietaryPreferences?.trim() || null;
    if (!allergies && !dietary) continue;
    const key = p.ticket.userId;
    const entry = byUser.get(key) ?? { nickname: p.ticket.user.nickname, realName: p.ticket.user.realName, allergies, dietary, packages: [] };
    entry.packages.push(`${p.package.name} (${p.variant.name})`);
    byUser.set(key, entry);
  }

  return {
    meals: meals.map((m) => {
      const v = perMeal.get(m.id) ?? new Map<string, number>();
      const variants = [...v.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "sv"));
      return { id: m.id, name: m.name, servedAt: m.servedAt, total: variants.reduce((s, x) => s + x.count, 0), variants };
    }),
    allergies: [...byUser.values()].sort((a, b) => a.nickname.localeCompare(b.nickname, "sv")),
    purchases: purchases.length,
  };
}
