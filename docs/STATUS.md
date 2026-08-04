# Where the project stands — 4 August 2026

**Live: https://loyanexa-new.fly.dev** · `main` at `0a89471` · **438 tests** · typecheck clean

---

## Sign in first

The app now has accounts. Yours is already created and your six cards are still attached.

```
https://loyanexa-new.fly.dev/signin
email     ahmedabdulalgane@gmail.com
password  (in the chat — change it once you're in)
```

Until you sign in, `/app`, `/customers`, `/reports`, `/settings` and `/notifications` all
redirect to the sign-in page. That is the point: **before tonight, anyone with the URL could
create cards, edit yours, and read your customers' names and phone numbers.**

---

## The whole journey now works

| Step | Where |
|---|---|
| 1. Sign in | `/signin` |
| 2. Design a card — logo, stamp icon, background image, colours, labels | `/app` → **Edit** |
| 3. Add a shop location so the card appears when customers walk past | `/settings` |
| 4. Add staff with a PIN, so they can stamp without seeing your reports | `/settings` |
| 5. Print the counter poster | card → **Print** |
| 6. Customer scans → enrol page in your colours → **Add to Wallet** | `/<linkCode>` |
| 7. Staff open the stamp screen, enter their PIN, scan | `/stamp` |
| 8. **The stamp appears on the customer's phone by itself** | — |
| 9. Send an offer to every card holder | `/notifications` |
| 10. See who came back and what it earned | `/customers`, `/reports` |

---

## What was built overnight

- **Authentication** — sign-up and sign-in, scrypt password hashing, sessions in Postgres,
  `HttpOnly`/`Secure`/`SameSite=Lax` cookies, logout that invalidates server-side.
- **Merchant scoping** — every query filtered by owner. Another merchant's card id returns
  **404, never 403**, so no id is even confirmable. Fourteen tests exist purely to prove one
  merchant cannot reach another's data.
- **Copy review** — 26 Arabic corrections (hamza placement, taa marbuta, terminology,
  Arabic-Indic numerals) and 11 English (British spelling, terminology, a mislabelled table
  header). Style guide at `docs/COPY.md`.
- **Location reminders** — geofences inside the pass, capped at Apple's limit of 10. No map
  library, no geocoding call, so no third party learns your merchants' addresses.
- **Staff PINs** — a PIN session opens only the stamp screen, provably refused on all 13
  merchant routes. Stamps record which staff member made them.
- **Broadcasts** — a Postgres job queue with `SELECT … FOR UPDATE SKIP LOCKED`. Two workers
  running at once were proven not to double-send across 40 recipients.

## Bugs found and fixed on the way

- **The Wallet pass and enrol page ignored `card.lang`** — every card rendered in English
  regardless of the language it was set to.
- **The welcome message fanned out to every existing customer** on a card instead of only
  the new one.
- **`POST /signup` had no rate limit.** One `curl` loop would have filled the merchant table
  and pinned the single 512 MB machine — `scryptSync` blocks the event loop — taking the live
  enrol pages down with it.
- **This deploy would have locked you out.** Your merchant row predates auth, so it had no
  password: sign-in failed and sign-up refused the email as taken. Fixed, documented in
  `docs/DEPLOY.md`, and your account was provisioned before you woke.
- **A broadcast retry could resurrect an older message** on a customer's pass after backoff.
- A timing side-channel in sign-in, and a timezone bug in raw-SQL timestamp comparisons.

---

## Two deliberate deviations from the spec

Both recorded in `docs/BUILD.md` §2 with dated notes rather than silently contradicting it.

- **Session auth instead of Firebase.** Firebase needs console setup that could not happen
  while you were asleep. It remains the migration path for Google sign-in and magic links.
- **Postgres job queue instead of BullMQ on Redis.** No Redis is provisioned.
  `FOR UPDATE SKIP LOCKED` is the correct idiom and is proven safe under concurrency.

## Still needs you

1. **Change your password** once you're in.
2. **Fix the APNs key** — Keys → `7GN2RZVL4L` → Configure → **Sandbox & Production**. Live
   updates currently run on the Pass Type ID certificate, which works but **expires
   1 September 2027**; §18 ranks that as a silent failure. The key does not expire.
3. **Google publishing access** — passes carry a "Test" badge until it is granted.

## Not built

Billing (Stripe and the three plans in §14), birthday and win-back automations beyond their
triggers, card templates, and the optional Flutter merchant app (sub-project 8).

## Recorded, not fixed

- `/img/:hash`, `/preview.png` and `/qr.png` are deliberately public — the enrol page needs
  them — which makes `/qr.png` an open QR generator on our domain.
- Expired sessions are cleaned lazily on access rather than swept periodically.
- Staff PIN sign-in cost scales mildly with headcount.
