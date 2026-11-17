> **All rights reserved.** Copyright (c) 2026 IT SERVICES BY RAJAT AGARWAL. This repository is public so the code can be read and reviewed; it is not open source and no licence to use or copy it is granted (see `LICENSE`). Secrets, keys and data are never kept here. Tests run automatically on GitHub's free servers (see `.github/workflows/test.yml`); that workflow never deploys.

# MOM v2 (Minutes of Meeting)

Meetings become numbered action points with owners, statuses, history, sharing, a public chain log and PDF export.
Built for Cloudflare Pages Functions + D1 (free tier). Planned home: `mom.veridian-aios.com`.

- Static front end: `public/` (plain JavaScript, hash-routed, mobile first, no build step).
- API: one pure router `src/server/api.ts`, used by the Pages Function (`functions/api/[[path]].ts`), the local dev server and the tests.
- Database: D1 / SQLite, migrations in `migrations/`.
- Rules in short: statuses Complete / WIP / In progress / Discarded; several owners per point; every change is an append-only history event; a published MOM cannot be deleted by a simple tap (only "delete for everyone", which leaves a visible notice); merge shows a warning first; every share and open is in the public chain log.

## Run it on your laptop (no accounts, no cost)

```
bun install
cp .dev.vars.example .dev.vars        # optional; defaults work
bun run dev -- --seed                 # http://localhost:8788  (loads an invented demo team)
```

Sign in with a demo e-mail such as `asha@sunrise-demo.example`. In dev mode the 6-digit code is shown on the screen and every e-mail is kept in the in-app "Dev mailbox" (More menu). Nothing leaves the machine: mail, payments and calendars all run in mock mode until you add keys.

Other commands:

| Command | What it does |
|---|---|
| `bun test` | Runs the whole suite: server tests on in-memory SQLite plus DOM-level UI tests that run the real `public/app.js` against the real API (fake network only) |
| `bun run typecheck` | TypeScript check (use `NODE_OPTIONS=--max-old-space-size=1536` on a small machine) |
| `bun run seed` | Loads the demo team into `.dev-data/mom.sqlite` (idempotent, local only) |
| `bun run build` | Copies `public/` to `dist/` and writes `_routes.json` |
| `bun run db:local` | Applies migrations to wrangler's local D1 |

## Database

`migrations/0001_init.sql`, `0002_hardening.sql`, `0003_hardening2.sql`, `0004_central_pay.sql` (23 tables, and one added column for the payment key id). Verified by applying all three to a real local D1 (`wrangler d1 migrations apply mom-db --local`): the 23 tables and the 3 triggers are created, and the database itself refuses to edit the audit log.

- Every write is one atomic D1 batch that includes its history event. A guard (`changes() > 0`) stops the history line from being written when the change itself lost a race, so the log never claims a change that did not happen.
- MOM history (`events`) can never be edited or deleted by the app or by a stray query (database triggers); `audit_log` cannot be edited. The only allowed change is erasing the free text of a MOM that was "deleted for everyone".
- Paying is atomic: the order is marked paid and the plan extended in the same batch; a failure in between leaves the order unpaid so the retry finishes the job. A plan is never extended twice.
- People are invited, not pre-created: adding an e-mail to a MOM or the team makes an `invites` row (counted in the 10 seats). The person joins by proving the mailbox. Nobody can squat or move another person's address, and only the team owner can bring new addresses in.

## Safety behaviours worth knowing

- **E-mail fails closed.** In production without a mail provider (`CF_EMAIL_TOKEN` + `CF_ACCOUNT_ID`, or `RESEND_API_KEY`) and `MAIL_FROM`, sign-in answers "e-mail is not switched on yet" (503) instead of pretending a code was sent, and `/api/config` reports `mail.ready:false` so the screens warn. Sign-in/share codes and notices have separate daily budgets, so neither can starve the other. In production the outbox keeps no message body (no codes, no share tokens), and rows are purged after 30 days.
- **Share links** expire (`SHARE_TTL_DAYS`, default 30), can be cancelled by whoever made them or the MOM owner (cancelling also ends guest sessions opened through them), and an e-mailed link opens only for the address it was sent to. A WhatsApp link is a bearer link: whoever opens it confirms their own e-mail and shows up in the chain. The chain says "made a WhatsApp link", because we cannot know it was actually sent. Anyone holding a valid link can read a masked public chain (outside addresses shown as `p***@out.test`), never the MOM itself.
- **Signed-in people stay signed in** when they open someone else's link: the guest view is a separate cookie, selected with `?as=guest`.
- **Rate limits**: code requests are limited per client address (hashed `CF-Connecting-IP`, `AUTH_IP_PER_HOUR`, default 10/hour) on top of the per-e-mail limits. Every change from the browser carries an `Idempotency-Key`, so a double tap or a retry after a dropped connection never repeats an action.
- **Delete for everyone** erases the notes, points, files, updates and the old change text; the tombstone, who/when and the audit trail remain.
- **PDF**: the built-in PDF font covers Western (Latin-1) letters only. If a MOM contains other scripts (for example Hindi) the file is marked lossy and the screen sends the person to the print view (Save as PDF from the browser), which draws every script.
- **Receipts / refunds**: a paid order has a payment receipt (it becomes a GST invoice only once the owner supplies `PAYEE_GSTIN`). "Ask for a refund" records a request (and mails `SUPPORT_EMAIL` if set); nothing is ever refunded automatically and no payout logic exists.

## Deploy (only when the owner says so)

1. `bunx wrangler d1 create mom-db`, then put the printed id in `wrangler.toml` (`database_id`).
2. `bunx wrangler d1 migrations apply mom-db --remote`
3. Secrets, one at a time, via `bunx wrangler pages secret put NAME`:
   `SESSION_SECRET` (long random, **required**), `TOKEN_ENC_KEY` (random, for calendar tokens),
   `CF_EMAIL_TOKEN` + `CF_ACCOUNT_ID` + `MAIL_FROM` (the free Cloudflare Email Service is the default provider for every product; the sender must be on a domain onboarded to Cloudflare Email Sending; **required in production**: without them nobody can sign in). `CF_ACCOUNT_ID` must be exactly 32 hex characters and the token plain printable text (anything else counts as not set, and sign-in then says e-mail is not switched on); `MAIL_FROM` must be one address, plain or `Name <address>`. `RESEND_API_KEY` still works when the two Cloudflare secrets are not set,
   `GOOGLE_CLIENT_ID/SECRET`, `MS_CLIENT_ID/SECRET` (leave unset for mock calendars),
   `PAY_SERVICE_KEY` (secret, piped in; this site's key for the central payment service), `PAY_SITE` (the site's registered host in the central ledger), optional `PAY_SERVICE_URL`, `PAY_LIVE_OK`. **No Razorpay key is kept here.** Payments follow the owner's Games pattern: order and verify go to https://itservices-rajat-agarwal.pages.dev and the buyer pays in its `/payframe/`. Not connected yet: this site must first be registered in the central ledger, and its address added to BOTH the payment frame's `ALLOWED` origins (in `build.py`, `PAYFRAME_JS`) and the `frame-ancestors` of `/payframe/*` in the central site's headers, and a `site` row for `PAY_SITE` with this site's key hash (all on the owner's side). Apply migration `0004_central_pay.sql`.
   Optional: `SUPPORT_EMAIL`, `PAYEE_GSTIN`. Plain variables (in `wrangler.toml`): `MAIL_DAILY_CAP`, `CODE_DAILY_CAP`, `AUTH_IP_PER_HOUR`, `SHARE_TTL_DAYS`.
4. `bun run build`, then `bunx wrangler pages deploy dist --project-name mom-app`.
5. In the Cloudflare dashboard attach the custom domain `mom.veridian-aios.com` to the Pages project. Calendar OAuth redirect URIs: `https://<host>/api/integrations/google/callback` and `.../microsoft/callback`. There is no payment webhook on this site: the central payment service owns the Razorpay webhook.
6. Set `ENFORCE_PLAN = "1"` in `wrangler.toml` only once payments are live (it blocks writes after the 14-day trial). While it is `0` the screens say editing is still on, instead of claiming it is locked.
7. Strongly recommended before a public launch: turn on Cloudflare Turnstile (or a WAF rate-limit rule) in front of `/api/auth/start` and `/api/shared/*/code`. The per-address limit stops a single abuser; a distributed one needs a CAPTCHA (see `ASSUMPTIONS.md`).

In production (`MOM_MODE = "production"`) the dev code hint, dev mailbox and mock payment route do not exist, and without the central payment service connected checkout answers "Payments are not switched on yet" instead of pretending.

## Pricing and money

Rs 499 per month or Rs 4,999 for 12 months, team of up to 10 users, 14-day free trial. The server decides every price. Every payment goes through the central payment service of IT SERVICES BY RAJAT AGARWAL (the Games pattern); this code never talks to Razorpay and holds no Razorpay key (a live key seen in the central answer is refused unless `PAY_LIVE_OK=owner-approved`). No payout logic exists.

The "30% productivity" line is shown only as an aim ("Aim to increase ... by 30%*", footnote "*Target, results vary.").

See `ASSUMPTIONS.md` for design decisions and known limits.

## Payments: owner's checklist and recovery (central payment service)
- Do NOT keep any `RAZORPAY_*` secret on this project and delete any Razorpay webhook that points at `/api/billing/webhook` (that route no longer exists). Payments need only `PAY_SERVICE_KEY`, `PAY_SITE` and, once the owner approves live, `PAY_LIVE_OK=owner-approved`. Set `PAY_LIVE_OK` only when the central service runs live Razorpay keys (a test key is then refused). A payment made with a Razorpay TEST key never buys a plan (the server answers 409 TEST_PAYMENT and the order stays open), whatever `ENFORCE_PLAN` says; an unpaid test order from before go-live is not reused once `PAY_LIVE_OK` is set. A "not paid" answer from the service does not mark an order failed.
- `PAY_SERVICE_URL` must stay the default (`https://itservices-rajat-agarwal.pages.dev`): `public/_headers` allows that one frame host only.
- Owner's side, central service: add a site row for `PAY_SITE` (key hash), add a site code for MOM so the ledger can number its payments, add `https://mom.veridian-aios.com` to the payment frame's `ALLOWED` origins and to the `frame-ancestors` of `/payframe/*`. Only the production host can pay; a `*.pages.dev` preview is not on the allow-list.
- If a buyer paid but the plan did not start (the browser never reported the payment, for example a UPI app switch killed the tab): the billing page shows the order as "created" with its order number. In the central ledger the payment's `payment_ref` equals that order number. After checking it there, extend by hand: `UPDATE orders SET status='paid', payment_id='<razorpay payment id>', paid_at=<now ISO> WHERE id='<order number>' AND status!='paid';` and then set the team's `plan` and `plan_until` in `orgs` (`plan_until` must be written exactly like `2027-01-31T00:00:00.000Z`; any other format is ignored when the next payment is added) (monthly = 30 days, yearly = 365 days from the later of today and the current end).
