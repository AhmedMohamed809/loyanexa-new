# Where the project stands — 4 August 2026

**Live: https://loyanexa-new.fly.dev** · `main` at `7c121c6` · **474 tests** · typecheck clean

---

## Notifications are now a moment, not card content

Your report: send two notifications, then a new customer installs the card — and they see
every previous notification. Fixed, plus a second bug found on the way.

**What caused your report.** Enrolment is idempotent by phone number: re-scanning with the
same number returns your *existing* card, so your stamps are still on it. Correct — but that
existing card came back carrying its old message too. A genuinely new phone number always
got a clean card; the sending side was never broken.

**Now:** a message expires **15 minutes** after it is sent (`BROADCAST_MESSAGE_TTL_MINUTES`).
Once it expires the card stops carrying it, and a sweeper pushes the update so the phones
already out there drop it too — not just cards issued later. A customer who enrols after you
sent something sees nothing until you send the next one. The full history stays on
`/notifications`: what was sent, when, to how many, and whether it has expired.

**The second bug.** The first version read "no expiry set" as "never expires". That exempted
every card issued before the change from the whole feature — **9 of the 12 cards carrying a
message on the live database**, each pinned to a months-old broadcast permanently. That was
your original complaint, unfixed for exactly the customers who had it. A NULL expiry now
means expired, the sweeper clears those rows, and a migration retired the 9. Verified live:
0 remaining.

**One honest caveat.** A back field's *first ever* appearance may not raise a lock-screen
banner, because iOS has no previous on-device value to compare against. Apple does not
document its diffing precisely enough to settle it, and it could not be tested without a
device. So the very first notification a given customer receives may appear on the card
without a banner; every one after that behaves normally. **Worth watching next time you
send one.** The alternative — keeping a permanently blank field on every card so there is
always something to diff — is what caused the bug you reported.

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
