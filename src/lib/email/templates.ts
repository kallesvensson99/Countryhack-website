export type Locale = "sv" | "en";

export interface TemplatePayloads {
  "verify-email": { name: string; url: string };
  "reset-password": { name: string; url: string };
  broadcast: { subject: string; body: string };
}

export type TemplateName = keyof TemplatePayloads;

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function layout(locale: Locale, bodyHtml: string): string {
  const footer = locale === "sv" ? "Cable connectors spelsällskap (CCSS)" : "Cable connectors gaming society (CCSS)";
  return `<!doctype html><html lang="${locale}"><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#111">${bodyHtml}<hr style="margin-top:32px;border:none;border-top:1px solid #ddd"><p style="color:#666;font-size:12px">${footer}</p></body></html>`;
}

function button(url: string, label: string): string {
  return `<p><a href="${esc(url)}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${esc(label)}</a></p><p style="font-size:13px;color:#555">${esc(url)}</p>`;
}

type Renderer<K extends TemplateName> = (p: TemplatePayloads[K], l: Locale) => Rendered;

const renderers: { [K in TemplateName]: Renderer<K> } = {
  "verify-email": (p, l) => {
    const t =
      l === "sv"
        ? { subject: "Bekräfta din e-postadress", hi: `Hej ${p.name}!`, line: "Klicka på knappen för att bekräfta din e-postadress. Länken gäller i 24 timmar.", cta: "Bekräfta e-post" }
        : { subject: "Confirm your email address", hi: `Hi ${p.name}!`, line: "Click the button to confirm your email address. The link is valid for 24 hours.", cta: "Confirm email" };
    return {
      subject: t.subject,
      html: layout(l, `<h2>${esc(t.hi)}</h2><p>${t.line}</p>${button(p.url, t.cta)}`),
      text: `${t.hi}\n\n${t.line}\n\n${p.url}`,
    };
  },
  "reset-password": (p, l) => {
    const t =
      l === "sv"
        ? { subject: "Återställ ditt lösenord", hi: `Hej ${p.name}!`, line: "Vi fick en begäran om att återställa ditt lösenord. Länken gäller i 1 timme. Om det inte var du kan du ignorera det här mejlet.", cta: "Välj nytt lösenord" }
        : { subject: "Reset your password", hi: `Hi ${p.name}!`, line: "We received a request to reset your password. The link is valid for 1 hour. If this wasn't you, ignore this email.", cta: "Choose a new password" };
    return {
      subject: t.subject,
      html: layout(l, `<h2>${esc(t.hi)}</h2><p>${t.line}</p>${button(p.url, t.cta)}`),
      text: `${t.hi}\n\n${t.line}\n\n${p.url}`,
    };
  },
  broadcast: (p, l) => ({
    subject: p.subject,
    html: layout(l, `<h2>${esc(p.subject)}</h2>${esc(p.body).replace(/\n/g, "<br>")}`),
    text: p.body,
  }),
};

export function renderTemplate<K extends TemplateName>(name: K, locale: Locale, payload: TemplatePayloads[K]): Rendered {
  return (renderers[name] as Renderer<K>)(payload, locale);
}
