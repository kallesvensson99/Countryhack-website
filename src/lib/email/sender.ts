import nodemailer from "nodemailer";
import { env } from "../env";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(msg: OutgoingEmail): Promise<void>;
}

export class SmtpSender implements EmailSender {
  private transport = nodemailer.createTransport({ host: env().SMTP_HOST, port: env().SMTP_PORT, secure: false });
  async send(msg: OutgoingEmail): Promise<void> {
    await this.transport.sendMail({ from: env().EMAIL_FROM, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
  }
}

export class ResendSender implements EmailSender {
  async send(msg: OutgoingEmail): Promise<void> {
    const key = env().RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env().EMAIL_FROM, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

let sender: EmailSender | undefined;

export function getEmailSender(): EmailSender {
  return (sender ??= env().EMAIL_PROVIDER === "resend" ? new ResendSender() : new SmtpSender());
}

/** Test hook. */
export function setEmailSender(s: EmailSender | undefined) {
  sender = s;
}
