import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["sv", "en"],
  defaultLocale: "sv",
  localePrefix: "always",
  localeDetection: false, // Swedish unless the visitor picks English; no Accept-Language redirect
});

export type Locale = (typeof routing.locales)[number];
