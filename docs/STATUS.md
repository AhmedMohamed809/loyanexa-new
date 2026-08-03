# Where the project stands — 3 August 2026

**Live: https://loyanexa-new.fly.dev** · `main` at `4b7fed9` · 192 tests · typecheck clean

---

## Try it in this order

| # | Do this | URL |
|---|---|---|
| 1 | Look at the marketing site | `/` |
| 2 | Create a loyalty card — drag the slider, change the colours, watch the strip redraw | `/cards/new` |
| 3 | Open the card, print the counter poster | `/app` → a card → **Print** |
| 4 | **Scan its QR with your phone** → enrol page in your colours | `/<linkCode>` |
| 5 | **Add to Apple Wallet** (or Google Wallet) | on the enrol page |
| 6 | Open the stamp screen on a phone, scan the card in your Wallet | `/stamp` |
| 7 | See the customer and the numbers move | `/customers`, `/reports` |

Language: append nothing and you get Arabic (the schema default). Set the `lnx-lang`
cookie to `en`, or use the toggle on the landing page, for English.

---

## What genuinely works

- **Real signed Apple Wallet passes.** Signed with the Tawila LTD Pass Type ID certificate;
  the signature chains to Apple Root CA and the field layout follows `BUILD.md` §9.1.
- **Google Wallet** save links — a real `LoyaltyClass` and `LoyaltyObject` per card.
- **The stamp screen** — camera decode via vendored `jsQR`, plus manual entry. Deliberately
  not `BarcodeDetector`, which does not exist on iOS (§8.15).
- **The 24-hour anti-fraud rule**, enforced server-side and atomically — the rule is
  re-checked inside the `WHERE` clause of the increment, so two concurrent stamps cannot
  both win.
- **The lock rule** (§8.7) — a card's economics freeze the moment a customer joins.
  Enforced server-side with a 409, not just greyed out in the UI.
- **Customers table with CSV export, reports from real rows, print-ready poster.**
- **PassKit web service** — all five endpoints, constant-time token comparison.
- Bilingual Arabic/English with RTL, 136 keys, parity gate in CI.

## What needs you

### 1. APNs — live pass updates are blocked on a portal setting

Stamping updates the database and regenerates the strip, but the pass already in your
Wallet will not refresh, because pushes are rejected:

```
api.push.apple.com          pass.com.loyanexa.loyalty  -> 403 BadEnvironmentKeyInToken
api.sandbox.push.apple.com  pass.com.loyanexa.loyalty  -> 400 BadDeviceToken   (topic accepted)
```

Both topics pass in sandbox and neither in production, so this is **not** topic scoping —
key `7GN2RZVL4L` is provisioned **sandbox-only**. Apple Wallet always pushes via production.

**Fix:** developer.apple.com → Certificates, Identifiers & Profiles → Keys → `7GN2RZVL4L`
→ Edit → APNs → Configure → make sure **Sandbox & Production** is selected → Save.
If the environment cannot be changed after creation, make a replacement key as
**Topic Specific** so it does not consume one of the two team-scoped slots.

The code is correct and already environment-configurable via `APNS_ENV`.

### 2. Does the pass actually install?

The `-noattr` bug that caused *"Sorry, your Pass cannot be installed"* is fixed — the
signature now carries the CMS signed attributes Apple requires. This has **not been
confirmed on a physical device**. Please try `/10001` and say either way.

### 3. Google publishing access

Passes carry a "Test" badge until it is granted (§9.5), and the business profile was sent
back for re-review when the support email was corrected.

---

## Deliberate gaps

- **No authentication** on the merchant pages. Firebase is a later sub-project; the UI is
  banner-marked and the code carries `TODO(sub-project 4)`. **Do not leave this URL with
  a merchant** until that lands — anyone can create and edit cards.
- **No `merchantId` scoping** on card routes. Inert with one merchant, but it is the hole
  that opens the day auth arrives. Fix it while the call sites are small.
- **Geofences** (§9.4) are not emitted yet — the spec calls them one of the strongest
  selling points, so they are worth doing early.
- **Billing** (Stripe), broadcasts (BullMQ) and the automated messages are not started.

## Known smaller issues, recorded not fixed

- `updateCard`'s lock check is TOCTOU — a customer enrolling in the millisecond gap could
  let an economic edit through.
- The QR encoder always uses mask 0 with no penalty scoring.
- `fly.toml` scales to zero, so a cold start rebuilds the APNs HTTP/2 session and JWT cache.
- `.env.example` has drifted from the variables actually used.
