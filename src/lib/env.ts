import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(32),
  SEAT_HOLD_MINUTES: z.coerce.number().int().min(1).default(30),
  EMAIL_PROVIDER: z.enum(["smtp", "resend"]).default("smtp"),
  EMAIL_FROM: z.string().default("CCSS <no-reply@localhost>"),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().default(1025),
  RESEND_API_KEY: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(["stripe", "mock"]).default("stripe"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  UPLOAD_DIR: z.string().default("./uploads"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Server-only. Parsed lazily so `next build` doesn't need secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error("Invalid environment: " + JSON.stringify(parsed.error.flatten().fieldErrors));
    }
    cached = parsed.data;
  }
  return cached;
}
