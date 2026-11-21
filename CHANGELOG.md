# Changelog

Newest first. Dates are in IST (Indian Standard Time, UTC+5:30).

Every deployed change needs: a version bump (MAJOR.MINOR.PATCH), a new entry here, an updated `public/version.json`, and an updated Version section in `KNOWLEDGE.md`, all in the same pull request.

## 2.0.0 - 2026-11-17 (IST)

First versioned record of the app as it already existed. The git history only has one snapshot commit (`2d3604b`, "Initial public snapshot (sanitized, no history)"), so earlier steps cannot be dated. `package.json` already said 2.0.0, so that is the version kept. Nothing about how the app behaves was changed by adding this record.

What the app does at this version:
- Meetings turn into numbered action points with owners, statuses (Complete, WIP, In progress, Discarded) and a full history.
- A MOM can be published, shared (e-mail or WhatsApp link), merged, exported to PDF, or deleted for everyone (which leaves a visible notice).
- Every share and open is written to a public chain log.
- Teams have up to 10 seats, with an owner, invitations and members.
- Sign-in uses e-mailed codes. Calendar links (Google, Microsoft) run in mock mode until the owner adds client details.
- Plans: 14-day trial, then paid plans. Payments go only through the central payment service. Without it connected, checkout says payments are not switched on. `ENFORCE_PLAN` is off.

Database steps already in `migrations/` (no separate dates are known):
- 0001: first database layout.
- 0002: sign-up details on codes, links between share and open events, lookup indexes.
- 0003: first review fixes (share link expiry and cancel, invitations, rate limits, repeat-safe writes, audit log, append-only history).
- 0004: keeps the public checkout key id returned by the central payment service so a second tap reopens the same order.
