import type { z } from "zod";
import { db } from "../db";
import type { profileSchema } from "../validation/account";

export type ProfileResult = { ok: true } | { ok: false; errors: Record<string, string> };

/** Members editing their own profile are not audited (only Admin/Festivalledare actions are). */
export async function updateProfile(userId: string, input: z.output<typeof profileSchema>): Promise<ProfileResult> {
  const nickTaken = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "User" WHERE lower("nickname") = lower(${input.nickname}) AND "id" <> ${userId} LIMIT 1`;
  if (nickTaken.length) return { ok: false, errors: { nickname: "validation.nicknameTaken" } };

  await db.user.update({
    where: { id: userId },
    data: {
      realName: input.realName,
      nickname: input.nickname,
      birthDate: input.birthDate,
      phone: input.phone,
      allergies: input.allergies ?? null,
      dietaryPreferences: input.dietaryPreferences ?? null,
      guardianName: input.guardianName ?? null,
      guardianPhone: input.guardianPhone ?? null,
      locale: input.locale,
    },
  });
  return { ok: true };
}
