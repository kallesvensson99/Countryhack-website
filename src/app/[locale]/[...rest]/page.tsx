import { notFound } from "next/navigation";

// Makes unknown URLs under /[locale]/ render the localized not-found page.
export default function CatchAll() {
  notFound();
}
