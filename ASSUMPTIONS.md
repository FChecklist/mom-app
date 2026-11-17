# Assumptions and known limits

Decisions I made where the brief was silent, and things that are deliberately not done. Change any of them freely.

## Product rules
- Publishing needs at least one point. Sharing needs a published MOM.
- Status moves: WIP and In progress move freely between each other and to Complete / Discarded. A Complete point can only re-open to In progress; a Discarded point only to WIP (stops finished work changing by accident). Complete and Discarded are struck through; each status has a colour and a symbol.
- Participants see published MOMs only, and can change a point only if they are one of its owners. The MOM creator and the **team owner** manage everything (the team owner can also see everybody's drafts: it is their team). Guests (opened via a share link after e-mail confirmation) are read-only for that one MOM and **cannot re-share** it.
- A point can be removed while its MOM is a draft (later points renumber). After publishing it can only be marked Discarded.
- A published MOM cannot be deleted with a plain delete (409). "Delete for everyone" needs an explicit confirm and leaves a tombstone ("This MOM has been deleted by @name on date at time"). The tombstone, who/when and the audit trail stay; the **content is really erased** (notes, points, updates, files, old change text).
- Merge always shows a warning and a preview first (409 until `confirm:true`). It creates a new draft, copies points (renumbered), owners, updates, attachments and **each point's own history**, and marks the originals "merged into". A MOM that was already merged cannot be merged again (that would duplicate every point); the merged result itself can be merged onwards.
- One team per e-mail address. The first person to sign up creates the team and is its owner. Teams are capped at 10 seats, **pending invitations count**. The owner can remove a member or cancel an invitation (history stays; the address becomes free) and hand ownership to a verified teammate (one owner at all times). Only the owner can bring new addresses into the team; members choose from existing people.
- An address that already has an account elsewhere is never moved by an invitation, and the owner's screen cannot tell whether an address exists elsewhere (same answer either way).
- WhatsApp sharing is a `wa.me` link with a ready message (no WhatsApp API, no cost). The chain says a link was **made**, not sent. An e-mailed link works only for its recipient's address; a WhatsApp/plain link works for anyone holding it after they confirm their own e-mail. Links expire after `SHARE_TTL_DAYS` (30) and can be cancelled.

## Money
- Mock payments exist only in dev/test. In production without the central payment service connected, checkout returns 503 rather than faking success. A live Razorpay key (visible in the central order answer) is refused unless the owner sets `PAY_LIVE_OK=owner-approved`. There is no Razorpay webhook here (it needs a Razorpay secret): a plan is extended only after the central service confirms the payment to the buyer's browser; if the payment service is busy right after the buyer paid, the page keeps the payment details (this tab only) and shows a "Check my payment" button, which is safe to press again; if the buyer closes the tab before the server confirms, the payment sits in the central ledger and the owner's side extends the plan by hand (follow-up: matching through central reconcile).
- A payment made with a Razorpay test key never activates a plan (a test card is public); the owner proves the central flow end to end with it and sees the audit entry `test_payment_verified`.
- `ENFORCE_PLAN` is off by default so a launch without live payments does not lock anyone out. A paid renewal made early adds time on top of the current period. Plans are prepaid and never renew by themselves, so there is nothing to cancel (the old "cancel whenever you like" copy was removed).
- Only the team owner can confirm a payment. Payment confirmation is atomic and idempotent (see README).
- Receipts: a payment receipt exists for each paid order. It is **not** a GST tax invoice until the owner provides the payee's GSTIN (`PAYEE_GSTIN`) and confirms the invoice wording with an accountant. Refunds are requests only, decided and paid out by the payee manually; no refund or payout code exists.

## Technical limits
- Files (PDF / image) are stored base64 in D1, at most 1,000,000 bytes each (D1 rows are limited to 2 MB). Larger files would need R2.
- `GET /api/state` returns the whole team's data, unpaginated. Fine for the 10-seat plan; add pagination before it grows.
- Daily mail caps (`MAIL_DAILY_CAP`, default 90, of which `CODE_DAILY_CAP`, default 55%, is for codes) are checked per send, so many truly simultaneous sends can slightly exceed them.
- Rate limiting is per hashed client address plus per e-mail. A distributed attacker using many addresses can still use up the daily code budget (the app then answers 503 rather than lying). A CAPTCHA (Cloudflare Turnstile, free) or a WAF rate rule in front of `/api/auth/start` and the share-code endpoint is the follow-up and needs the owner's Cloudflare dashboard.
- The PDF writer is Latin-1 only; other scripts need the browser's print view (the screen offers it automatically).
- Calendar adapters (Google, Microsoft) run in mock mode without client credentials. The live OAuth code path is written, has one-time state and error handling, but has never run against the real providers.
- Sessions are 30 days (7 for guests, ended at once if the link is cancelled or expires). Sign-in codes: 10 minutes, 5 attempts, 5 codes per hour per e-mail.
- Sign-in codes and share tokens are not kept in the production mail log; the dev mailbox (dev mode only) shows full text.
- Tests: server tests on in-memory SQLite (real SQLite, the same engine as D1), plus `tests/ui.test.ts`, which runs the real `public/app.js` in a DOM (happy-dom) against the real API for sign-in, create/publish, attachments (including a real file pick), WhatsApp, delete, merge, shared links and the retry/idempotency path. It is **not a real browser**: layout, touch behaviour and the Razorpay checkout window are untested by it.
- The migrations were applied to a real local D1 (miniflare) and the append-only triggers confirmed there. The partner laptop could not run wrangler (workerd needs the Visual C++ runtime, which is not installed there) but ran the whole suite.
- Nothing has been deployed, no real D1 database exists (`database_id` in `wrangler.toml` is a placeholder), and no real e-mail, Razorpay, Google or Microsoft call has been made.
- Demo data uses invented people at `@sunrise-demo.example` / `@guest-demo.example`; no real personal data is in the repo.
