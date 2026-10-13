import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export async function AdminNav({ active }: { active: "users" | "settings" | "audit" }) {
  const t = await getTranslations("nav");
  const items = [
    { key: "users", href: "/admin/users", label: t("users") },
    { key: "settings", href: "/admin/settings", label: t("settings") },
    { key: "audit", href: "/admin/audit", label: t("auditLog") },
  ] as const;
  return (
    <nav aria-label="Admin" className="flex gap-4 border-b border-slate-200 pb-2 text-sm">
      {items.map((i) => (
        <Link key={i.key} href={i.href} aria-current={active === i.key ? "page" : undefined} className={active === i.key ? "font-bold underline" : "hover:underline"}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
