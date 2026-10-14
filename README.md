# CCSS LAN

Web app for running LAN parties for **Cable connectors spelsällskap (CCSS)**: member accounts, events, ticket sales, seat booking on a visual chart, and food packages.

> **Status: all five stages done** — accounts/roles/GDPR/admin · events & ticket types · seating editor & booking · cart, payments, food, receipts, refunds · **check-in, meal collection, statistics, attendee list + CSV, email to attendees**.

Stack: Next.js 15 (App Router) · TypeScript strict · PostgreSQL 16 + Prisma 6 · Zod · custom session auth (argon2id) · Tailwind · next-intl (`sv` default, `en`) · Vitest + Playwright.

## Running locally

Prerequisites: Node.js 22+ and Docker (or any PostgreSQL 16 on `localhost:5432`).

```bash
cp .env.example .env            # then edit APP_SECRET (>= 32 chars)
docker compose up -d            # Postgres (dbs: ccss + ccss_test) and Mailpit
npm install
npx prisma migrate deploy       # or `npm run db:migrate` while developing the schema
npm run db:seed                 # test users (development only)
npm run dev                     # http://localhost:3000  → redirects to /sv
npm run worker                  # in a 2nd terminal: sends queued emails, purges old rows
```

- **Mailpit** (all outgoing mail in development): http://localhost:8025
- No Docker? Install PostgreSQL 16, create databases `ccss` and `ccss_test` and keep the default `DATABASE_URL` (`postgres:postgres@localhost:5432`).
- Emails go through the `EmailOutbox` table, so **the worker must be running** for verification / reset mails to be delivered.

### Seed users (development only)

All use the password **`Password123!`**.

| Email | Role | Notes |
|---|---|---|
| `admin@ccss.test` | Admin | users, tags, org settings, audit log |
| `leader@ccss.test` | Festivalledare | manage events at `/sv/manage/events` |
| `member@ccss.test` | Member | adult, verified |
| `minor@ccss.test` | Member, 15 years old | has guardian name + phone |
| `unverified@ccss.test` | Member | email not verified (can't buy) |

The seed also creates one published example event, **CCSS Höst-LAN** (`/sv/events/ccss-lan-hostlan`), with four ticket types (Crew is hidden and needs a code). It has a 60-seat chart (Standard + VIP zones, stage, entrance, kitchen, toilets), zone links on the ticket types, and a chart template. It also has five meals, three food packages (Helhelg, Fredagsmiddag, Frukostpaket — each with Standard/Vegetarisk/Vegansk) and two discount codes: **`CREW`** (100 %, unlocks the hidden Crew ticket) and **`EARLY10`** (10 %).

`prisma/seed.ts` refuses to run when `NODE_ENV=production`.

### Payments

Two providers behind the `PaymentProvider` interface, chosen with `PAYMENT_PROVIDER`:

- **`mock`** — a fake checkout page inside the app (`/dev/mock-pay`) with *Pay* / *Cancel* buttons. No account needed; it feeds the same webhook handler as Stripe. **Refuses to run unless `APP_URL` is localhost.** Used by the Playwright tests.
- **`stripe`** (default) — Stripe Checkout in **test mode** for development. Put test keys in `.env` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) and forward webhooks with the Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

The CLI prints the `whsec_…` signing secret to put in `STRIPE_WEBHOOK_SECRET`. Test card: `4242 4242 4242 4242`, any future date, any CVC. Stripe's minimum charge is about 3 SEK; free orders (100 % codes) skip Stripe entirely.

The webhook endpoint is `POST /api/webhooks/stripe` (signature-verified, idempotent via `WebhookEvent`). Events used: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`. In production create the endpoint in the Stripe dashboard with those events and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

## Event day

Festivalledare find everything under **Hantera event → (event)**:

| Page | What it does |
|---|---|
| **Incheckning** (`/manage/events/<id>/checkin`) | Mobile-first door tool. Scan the ticket QR with the camera (`@zxing/browser`), *or* search by name / nickname / order number, *or* paste a ticket code (hand scanners that "type" the code work too). The card shows name, ticket, seat, **allergies**, **guardian name + phone for under-18s**, food with per-meal *Hämta* buttons, and one big *Checka in* button. A second check-in warns "redan incheckad" and shows who/when. Online only. |
| **Deltagare** | Attendee list with search and filters (ticket type, checked in, has food, minors), guardian details, and CSV export. |
| **Statistik** | Tickets per type, seat occupancy per zone, revenue (received − refunded), food per package/variant, checked-in count. |
| **Mejla deltagare** | Subject + message to everyone with a paid ticket (confirm step, rate-limited, logged in `Broadcast`). |

Notes:

- **The camera needs HTTPS** (or `localhost`). In production Caddy provides that. Without a camera, search always works.
- **CSV** is UTF-8 with a BOM. The default uses **semicolons**, because Excel with Swedish regional settings treats `;` as the list separator (a comma-separated file would land in one column); a comma variant is offered too. Cells that start with `=`, `+`, `-` or `@` are neutralised against spreadsheet formula injection. Each export is written to the audit log because it contains personal data.
- Ticket QR tokens are `ccss1.<ticketId>.<nonce>.<HMAC>` signed with `APP_SECRET`; changing a ticket's `qrNonce` invalidates old printouts.

## Tests

```bash
npm run typecheck
npm run lint
npm test            # Vitest, real Postgres: database `ccss_test` (migrations applied automatically)
npm run test:e2e    # Playwright: builds the app, seeds ccss_test, runs desktop + mobile + "scanner" (Chromium)
npx playwright install chromium   # once
```

Vitest **truncates every table** in `ccss_test` between tests — never point `TEST_DATABASE_URL` at a real database (the setup refuses names not ending in `_test`).

Stage (e) adds: check-in (signed/tampered/foreign/rotated-nonce codes, search, 8 crew members racing for one ticket → exactly one wins, undo, minors by actual birth date incl. the 18th-birthday boundary, per-meal collection), statistics (incl. partial refunds), attendee filters, CSV (BOM, delimiters, quoting, formula neutralisation, route authorisation + audit), broadcast (recipients, outbox, language, rate limit). End-to-end in a browser, including **scanning a real ticket QR through a fake webcam** (Chromium plays a generated video of the QR).

Stage (d) adds: pricing and exact discount allocation; checkout rules (age rule, windows, stock, one ticket per member, code unlocking, zones, food rules); stock / code-use / seat races under concurrency; idempotent webhooks (also 5 simultaneous deliveries); late payments (seat re-taken, seat lost, conflict); order expiry incl. retrying a failed session close; full / partial / failed refunds; Stripe signature verification (incl. replay protection) and the webhook route; QR signing; food and discount-code management; kitchen summary; receipts and confirmation emails.

Stage (c) adds: 50-way concurrent claims on one seat (exactly 1 wins), expired-hold reclaim, one-seat-per-ticket, atomic moves, claim-vs-chart-save races, chart save rollback and claim protection, templates, the seat-map privacy guarantees (nicknames only when allowed, no personal data), and the editor operations.

Stage (b) adds: Stockholm⇄UTC time handling (DST gaps), event create/update/status flow (incl. concurrent transitions), full event duplication (zone remapping, nothing transactional copied), ticket types (zone ownership, sold-quantity guards), draft visibility, image upload (magic-byte sniffing, replace/delete, shared files).

What's covered in stage (a): role × action permission matrix (162 cases), registration / verification / login / reset / rate limiting, the one-active-ticket-per-event index, the birth-year age rule, minors' guardian rule, admin tag rules (last-admin race), org-settings audit, GDPR export + anonymization, email outbox (retry, concurrency).

## Project layout

```
prisma/            schema.prisma, migrations (incl. raw SQL for partial/expression indexes), seed.ts
src/app/[locale]/  pages (sv/en)         src/actions/   Server Actions (thin: validate → can() → service)
src/lib/auth       sessions, passwords, tokens, rate limiting, account service
src/lib/permissions  can(user, action, resource) — every permission rule
src/lib/audit      AuditLog writer + diff        src/lib/email  outbox, templates (sv/en), Resend/SMTP senders
src/lib/gdpr       export + anonymize            src/worker     1-minute loop
messages/          sv.json, en.json              tests/, e2e/
```

Conventions: money is integer **öre**; times are stored in UTC and shown in Europe/Stockholm; all UI strings live in `messages/*.json`; every write goes through a Server Action that calls `assertCan()`.

## Deploying to a VPS (Docker Compose + Caddy)

1. Point your domain's DNS A/AAAA record at the server; open ports 80/443. Install Docker + the compose plugin.
2. Copy the repo to the server and create `.env.production` (never commit it):

   ```ini
   NODE_ENV=production
   SITE_DOMAIN=lan.example.se
   APP_URL=https://lan.example.se
   POSTGRES_PASSWORD=<long random>
   APP_SECRET=<openssl rand -base64 48>
   SEAT_HOLD_MINUTES=30
   EMAIL_PROVIDER=resend
   EMAIL_FROM="CCSS <no-reply@lan.example.se>"   # domain must be verified in Resend
   RESEND_API_KEY=re_...
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   UPLOAD_DIR=/app/uploads
   ```

3. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`
   - `app` applies pending migrations on start, then serves on :3000 behind Caddy (automatic HTTPS).
   - `worker` is the same image running `npm run worker` (loop every minute) — this is the "cron".
4. Create the first admin: register through the site, then promote the user in SQL (afterwards use the admin UI):

   ```bash
   docker compose -f docker-compose.prod.yml exec db psql -U ccss ccss -c \
     "INSERT INTO \"UserTag\" (id, \"userId\", tag, \"updatedAt\") SELECT 'bootstrap-admin', id, 'ADMIN', now() FROM \"User\" WHERE email = 'you@example.se';"
   ```

   Then fill in organisation number and address under **Admin → Inställningar** (shown on receipts).
5. **Do not run the seed in production.**

### Backups

```bash
# Postgres (daily via host cron), keep >= 7 years of accounting data per bokföringslagen — archive monthly dumps off-site
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U ccss -Fc ccss > backup/ccss-$(date +%F).dump

# Uploads volume
docker run --rm -v ccss-lan_uploads:/data -v "$PWD/backup":/backup alpine tar czf /backup/uploads-$(date +%F).tgz -C /data .

# Restore
docker compose -f docker-compose.prod.yml exec -T db pg_restore -U ccss -d ccss --clean --if-exists < backup/ccss-YYYY-MM-DD.dump
```

(Volume names are prefixed with the compose project name; check with `docker volume ls`.)

## Decisions & notes for stage (a)

See the stage summary in the conversation; the short version:

- Admin can view draft events but does **not** implicitly get Festivalledare's management rights (an admin can grant themselves the tag).
- Email is not editable on the profile (avoids re-verification flows for now).
- Registration says when an email/nickname is already taken (rate-limited per IP); password reset never reveals whether an account exists.
- Locale is Swedish unless the visitor picks English — no `Accept-Language` redirect.
