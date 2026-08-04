# LoyaNexa — Build Specification

Single source of truth. Everything needed to build the platform is here.
A working MVP of the full flow ships alongside this file as `loyanexa-mvp.html` — open it
to see every screen behave before writing a line of production code.

**Product:** digital loyalty cards that live in Apple Wallet and Google Wallet.
**Audience:** independent businesses — cafés, bakeries, barbers, salons, car washes, gyms.
**Languages:** Arabic and English, full RTL.

---

## 0 · The constraint that defines the product

**Nobody is ever *required* to install an app. Not the customer, not the merchant.**

- The **customer** scans a printed QR → a web page opens → one tap → the card is in the
  wallet already on their phone.
- The **merchant** stamps from a **browser page** using the device camera.

Competitors in this category require merchants to download a scanner app. We do not.
Anywhere a competitor flow says "download the app", ours says **"open the stamp screen"**.

**Reject any proposal that makes an app mandatory for either party.** A merchant must
always be able to run the entire business from a browser, on any device, with nothing
installed. That is the differentiator and it is not negotiable.

An **optional** merchant app is permitted, and planned as sub-project 8 — a Flutter app
that opens straight to the camera after login, for high-volume merchants who prefer it.
It is an addition for convenience, never a replacement, and never a prerequisite. If the
browser stamp screen ever stops being fully sufficient on its own, the product has lost
the thing it was built on.

**Corollary:** the customer enrol page stays plain HTML with no framework. It is one form
opened on café wifi, and enrolment rate is the metric the whole business rests on.

---

## 1 · Users — and a correction about scale

| Population | Count | Signs in? | Load |
|---|---|---|---|
| **Merchants** (paying) | 1,000–10,000 | Yes | Light — occasional dashboard use |
| **Pass holders** (end customers) | up to 1,000,000+ | **Never** | Enrol once, then wallet polling |

"A million users" is **not** a million authenticated sessions. Auth load is ~10k.
Real load is APNs pushes and pass re-downloads after stamps and broadcasts.
At 1M passes × ~4 visits/month ≈ **1.5 stamps/sec average, ~50 at peak** — one 4-core
server handles this **provided the strip cache exists** (§10).

---

## 2 · Stack

| Layer | Choice | Why |
|---|---|---|
| Auth | **Firebase Auth** | Google sign-in, magic link, verification, reset — free at 10k merchants |

> **Deviation, 2026-08-04.** The app shipped to production with **no authentication at
> all** — any visitor could create cards, edit another merchant's cards, and read
> customer names and phone numbers. That is the highest-priority gap this note fixes, and
> it shipped as **self-contained session auth**, not Firebase Auth as this section
> specifies: standing up a real Firebase project needs console access the owner cannot do
> right now, and shipping the fix could not wait on that. What's live instead —
> `apps/demo/auth.ts`: email + password hashed with **scrypt** (`node:crypto`, a random
> per-user salt, `N=16384/r=8/p=1`, `crypto.timingSafeEqual` for comparison — never a
> plain hash, never a fast one), sessions as opaque random ids in a Postgres `Session`
> table (deleting the row is what makes sign-out and expiry invalidate a session
> **server-side**, not just clear a cookie), and an `HttpOnly`/`Secure`/`SameSite=Lax`
> cookie rotated on every sign-in. No new npm dependency — `node:crypto` covers both
> hashing and session-id generation. Every merchant route now resolves its merchant from
> that session and filters every `Card`/`Pass`/`StampEvent`/`CardImage` query by it; a
> card id belonging to another merchant 404s, never 403s, so a request can never confirm
> someone else's id is real. **Firebase remains the intended migration path** for what
> this cannot do on its own — Google sign-in and magic-link email — and nothing here
> forecloses it: `Merchant.firebaseUid` stays in the schema, nullable and unused, for
> exactly that later migration. See `apps/demo/auth.ts` for the implementation and
> `apps/demo/test/auth.test.ts` / the scoping test suite for what it's verified against.
| Database | **Postgres** (Neon or Supabase) + Prisma | Queries are relational |
| API | **Node + TypeScript + Fastify** | Persistent process, 2–3× faster than Express |
| Cache | **Redis** (Upstash) | Strip images + sessions |
| Queue | **BullMQ** on Redis | APNs broadcast fan-out |
| Storage | **Cloudflare R2** | Logos and strips; zero egress fees |
| Hosting | **Fly.io** or Railway | Long-lived container |
| Frontend | **Next.js** (App Router) | Landing + dashboard |
| Enrol page | **Plain HTML/CSS/JS** | Must stay ~4 KB |

> **Deviation, 2026-08-04.** Merchant broadcasts (BUILD.md §8.12) shipped on a
> **Postgres-backed job queue**, not **BullMQ on Redis** as this row specifies:
> there is no Redis provisioned, and standing one up for this one feature was
> judged more moving parts than the night warranted, the same trade-off §2's
> auth note above made for session storage. What's live instead —
> `packages/db/prisma/schema.prisma`'s `BroadcastJob`/`BroadcastRecipient`
> tables plus `apps/demo/broadcastWorker.ts`'s in-process `BroadcastWorker`:
> `enqueueBroadcast()` (`apps/demo/broadcast.ts`) only ever inserts rows, so
> the request handler that calls it returns immediately (BUILD.md §18 item 6);
> the worker claims batches with a single atomic
> `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED) …` statement — the
> standard Postgres job-queue idiom — which is what lets two machines run
> this worker at once without ever double-claiming the same recipient row, no
> distributed lock of its own required. Retries are bounded with exponential
> backoff, a stale claim (a worker that died mid-send) is reclaimed after a
> timeout rather than lost, and a `410 Gone` prunes the `Device` row exactly
> as the existing per-stamp push path already does. **Redis/BullMQ remains
> the path forward** if throughput ever demands true horizontal fan-out speed
> a single Postgres table can't give — nothing here forecloses it, the same
> way `Merchant.firebaseUid` stays reserved for a later Firebase migration.
> See `apps/demo/broadcastWorker.ts`'s file header for the full design, and
> `apps/demo/test/broadcastWorker.test.ts` for the two-workers-concurrently
> proof that no recipient is ever pushed twice.

### Explicitly rejected

- **Firestore** — the core query ("passes for this merchant not stamped in 21 days") is
  relational. Postgres: one index, 27 ms on 200k rows (measured). Firestore bills per
  document read; the stats page alone would read thousands per load.
- **Cloud Functions for wallet work** — cold starts plus per-100ms billing against ~93 ms
  of image generation. Worse, **APNs uses long-lived HTTP/2 connections**; serverless
  rebuilds TLS every invocation.
- **FCM** — **does not drive wallet passes at all.** Wallet updates go through **APNs
  directly**, authenticated by the Pass Type ID certificate. FCM is for app notifications,
  and there is no app.

> **Correction, 2026-08-03.** An earlier revision of this section stated that token-based
> `.p8` authentication (a JWT signed with the APNs Auth Key) supersedes the certificate as
> the way this deployment talks to APNs. That is wrong for the certificate/key pair this
> app actually holds, and it sent live-update pushes to production nowhere for a while
> before it was caught. **Certificate-based mTLS — the line above, restored — is the
> working path**, not a fallback. Measured against the real Apple Wallet certificate and
> a deliberately invalid device token (so nothing was ever delivered to a real device):
>
> ```
> token (.p8)  api.push.apple.com          -> 403 BadEnvironmentKeyInToken
> token (.p8)  api.sandbox.push.apple.com  -> 400 BadDeviceToken   (works, wrong env)
> mTLS (cert)  api.push.apple.com          -> 400 BadDeviceToken   (Apple accepted the cert)
> ```
>
> `400 BadDeviceToken` in response to a token that cannot possibly be valid is Apple's
> signal that everything *before* device-token validation — including which auth method
> was presented — succeeded. The APNs Auth Key behind `APNS_KEY_ID`/`APNS_KEY` is
> provisioned **sandbox-only** in the Apple Developer portal; every token-authenticated
> push to `api.push.apple.com` (where Wallet devices actually register) is refused until
> that key is re-provisioned for Production there — a portal change, not a code fix. Until
> then, `packages/pass/src/apns.ts` defaults `APNS_AUTH` to `certificate`; `token` remains
> available and is the better *long-term* choice once the portal is fixed (a key doesn't
> expire yearly the way a certificate does), but it is not usable against production
> today. See `docs/DEPLOY.md`'s `APNS_AUTH` row for the operational detail.

Firebase-for-auth + Postgres-for-data + a persistent server is a deliberate hybrid.

---

## 3 · Brand

> **Revised 2026-08-03:** the owner's marketing landing page
> (`apps/demo/public/index.html`) supersedes the light palette immediately below. The
> product brand is now **dark by default** — see the current token table right after it.
> The light table is kept only for provenance; do not build new screens against it.

Sampled from the logo file — do not approximate.

| Token | Light *(superseded 2026-08-03)* | Dark *(superseded 2026-08-03)* |
|---|---|---|
| `--brand` navy | `#203757` | `#51637C` |
| `--brand-deep` | `#16263D` | — |
| `--accent` orange | `#F96400` | `#FA802E` |
| `--canvas` | `#F4F6FA` | `#070C14` |
| `--paper` | `#FFFFFF` | `#0B121C` |
| `--sunk` | `#EEF1F6` | `#0E1826` |
| `--ink` / `--ink-2` / `--ink-3` | `#16273D` / `#4A5A70` / `#8794A5` | `#EDF1F6` / `#A9B4C2` / `#76839A` |
| `--line` / `--line-2` | `#E3E8EF` / `#CFD7E2` | `#162334` / `#1C2C41` |
| `--green` / `--amber` | `#2E8B57` / `#B0802F` | `#5E9B77` / `#C9A055` |

**Current palette (revised 2026-08-03), sampled from the landing page — dark only, no
light variant:**

| Token | Value | Role |
|---|---|---|
| `--accent` | `#F28C38` | primary CTA, stamps, figures |
| `--accent-hover` | `#E67E22` | accent hover/active state |
| `--accent-light` | `#F7B267` | accent tint (badges, small highlights) |
| `--canvas` | `#0F172A` | page background |
| `--sunk` | `#162338` | recessed surface (nav, wells) |
| `--paper` | `#1C2A42` | card/panel surface |
| `--raise` | `#22314C` | raised surface (hover states, popovers) |
| `--ink` | `#FFFFFF` | primary text |
| `--ink-2` | `#CBD5E1` | secondary text |
| `--ink-3` | `#94A3B8` | tertiary text, placeholders |

**Orange is an accent, never a surface.** It carries stamps, figures, and one primary CTA
per view. Navy (canvas/sunk/paper/raise) does the structural work. Never orange text on
navy at body size. The new dark landing page honours this rule throughout — orange never
fills a background larger than a control.

Radii `8 / 10 / 14 / 18 / 22px`. Three low shadow levels; borders do most of the separating.
No gradients, no glass blur.

### Logo
Two cropped, background-removed files swapped by a CSS variable:
```css
:root                 { --logo: url('/logo.png') }
html[data-theme=dark] { --logo: url('/logo-dark.png') }
.brandmark{width:146px;height:30px;background-image:var(--logo);
           background-size:contain;background-repeat:no-repeat;background-position:left center}
html[dir=rtl] .brandmark{background-position:right center}
```

---

## 4 · Typography

> **Revised 2026-08-03:** **Alexandria** replaces the Tajawal/Cairo/Readex Pro/Inter/
> JetBrains Mono stack below, per the owner's landing page
> (`apps/demo/public/index.html`). Loading snippets (plain `<link>`, Next.js
> `next/font/google`, Vite, Tailwind, and the eventual self-hosted Fontsource path) live
> in `docs/FONTS.md` — reference that file rather than duplicating the code here.

```css
font-family: 'Alexandria', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
             Roboto, sans-serif;
```

Alexandria is **bilingual** — one family covers Arabic and Latin — so unlike the old
stack there is no separate face to load per language and no per-language family swap.
It also carries figures and codes itself; there is no separate mono face. It ships nine
weights (100–900); the product uses 300–800.

**Non-negotiable:** `html[lang=ar] * { letter-spacing: 0 !important }` — tracking breaks
Arabic letter joining. This one rule prevents the most common Arabic typography failure,
and it still applies unchanged under Alexandria.

**Alexandria is geometrically wider than Inter** — the old stack's heaviest negative
heading tracking (`-0.045em`) reads as cramped in it. Heading tracking eases to
`-0.025em`; Arabic headings stay at `0` per the rule above regardless.

---

## 5 · Design language

- **White top bar** floating over a **tinted canvas** (never white-on-white)
- **White panels**, radius 18px, soft shadow
- **Floating pill tab bar**, 5 tabs, active tab in the accent colour
- Setup band and wizard header use `--brand-deep`
- Buttons and chips fully rounded; inputs radius 10px with a 3px focus ring
- The **row of stamp slots** is the recurring motif

---

## 6 · Navigation

**Top bar:** logo · Demo · Support · **Stamp screen** · plan chip · merchant name · Sign out.
*(Competitors put a "download the scanner app" link here. Ours opens the browser scanner.)*

**Bottom floating tab bar:** `Reports · Customers · Cards · Notifications · Settings`

---

## 7 · Flows

### 7.1 Merchant
```
Landing → Sign up → Onboarding (one page) → Dashboard
  → Cards: pick type → templates or scratch → 7-step wizard → activate
  → short link + QR + print sheet
  → Stamp screen (browser camera)
  → Messages · Reports · Settings
```

### 7.2 Customer
```
Scans the printed QR → enrol page in the merchant's colours
  → consent → Add to Apple/Google Wallet → card in wallet
  → staff scan the card's QR each visit; counter updates within a second
  → walking near the shop surfaces the card on the lock screen automatically
```

### 7.3 Two different QR codes — never conflate them

| | Join QR | Card QR |
|---|---|---|
| Where | Printed, on the counter | Inside each customer's pass |
| Scope | One per card design, static | Unique per customer |
| Encodes | `https://loyn.me/11819` | the pass `serial` |
| Scanned by | The customer's phone camera | The merchant's stamp screen |

---

## 8 · Screens

### 8.1 Login
Brand canvas, centred: logo · Continue with Google · Continue with Apple · "or" ·
email · password with reveal · submit · forgot password · sign-up link · language toggle ·
cookie consent bar.

### 8.2 Onboarding — one page, not a wizard
- Business name
- Contact name — *"for invoices only, never shown on the card"*
- Phone with **country dial-code picker and flag** — *"this number appears on the card"*
- Country · Currency
- **Selected plan panel**: name · period chip · trial end date ·
  "we'll remind you 3 days before it ends" · "no credit card" with a green tick
- **Dashboard language**: two large cards, العربية / English
- Submit: "Create account and start the free trial"

### 8.3 Setup checklist
Band under the header: **"1/5 complete"** and five pills —
business info ✓ · complete profile · create your first card · add your location ·
add products. Collapsible. **Cheap to build, high impact on activation.**

### 8.4 Cards
**Empty:** tabs `My cards (0/1)` · `Templates`, centred empty state, primary button.

**Card type** — three options, badged:
- **Classic stamp card** — "most used" — **build this first**
- Car card — "custom experience" — vehicle + plate — *later*
- Café card — "AI powered" — cup design from brand identity — *later*

**Start method:** Browse templates · Start from scratch.

**Template gallery:** search · **import by code** (`TMP-A1B2C3`) · grouped by category ·
each renders as a real card preview.

### 8.5 Card creation — 7-step wizard
Persistent header: step name + hint · **Activate card** · Cancel.
**Live pass preview** with an **Apple / Google Wallet toggle**. Progress bar.

| Step | Contents |
|---|---|
| **1 · Logo & business** | business-type chips; logo upload (PNG/JPG/SVG). **Cropper modal** — rotate, flip, nudge, zoom, target 512×512. **AI logo generation** with a retry counter. Transparent-logo detection → *"we couldn't detect a background colour, pick one"* + hex + eyedropper |
| **2 · Stamp design** | icon picker · **shape: circle / square** · colours: card background, text, active stamp, inactive stamp · background opacity slider |
| **3 · Language** | English / العربية |
| **4 · Expiry** | **Unlimited** (default) or **Limited** → **Duration** ("valid for N days" + chips 1/3/6 months, 1 year) or **Fixed date** (full Arabic calendar) |
| **5 · Stamp count** | **slider 3 → 20**; preview redraws instantly (8 → 4+4, 11 → 6+5) |
| **6 · Reward** | free text + chips. **Preview flips to the pass BACK** |
| **7 · Review** | summary table; button "Looks great" |

### 8.6 Auto-generated terms
Built from the card's own settings — the merchant writes nothing:
1. 1 stamp per visit
2. Collect N stamps to get a reward
3. Card, stamps and rewards expiry are `<unlimited | N days | date>`
4. Stamps and rewards cannot be exchanged, returned or bought for cash
5. Cards cannot be transferred or combined with other cards
6. The company reserves the right to amend these terms

### 8.7 Activation modal — the lock rule
Warning icon, then **"after the first customer joins, these cannot be changed"**:
stamps required · starter stamps · how stamps are earned · reward details · expiry type.
Reason shown: *"to keep every customer's progress fair."*
In green: *"you can always change the design, colours, images and text."*

> **Enforce server-side, not just in the UI.** Economics freeze once real progress exists;
> aesthetics stay editable forever. This is the single best product idea in the category.

### 8.8 Post-activation
Tick · "Your card is live and ready to share" · **Copy card link** · **Print sheet** ·
"Go to cards".

### 8.9 Card edit — 3-step wizard
**Amber locked-fields banner**: *"some fields are locked because customers have already
joined — this keeps it fair for everyone"*, chips for each locked field, and
**"N customers registered on this card"**. Locked fields render greyed with a padlock.

1. **Settings** — card name · language · expiry (locked) · **issuance form builder**:
   a table of `field type | field name | delete`. Defaults Name + Phone; **+ Add field**
   offers Email and Birthday. Name is not deletable.
2. **Design** — stamp shape · alignment (3 layouts) · **separate active and inactive icons**
   · four stamp colours · opacity · **or custom 200×200 PNG uploads** ·
   card images (logo · **icon 512×512, required by Google Wallet** · cover) ·
   card colours · **custom labels, 16 characters each**
3. **Rewards and messages**

### 8.10 Card detail
Name · **Active** pill · type chip · four-cell fact row (reward · stamps · created ·
expires) · three counters (customers · stamps · rewards) · **Copy customer link** ·
**Print** · **Edit card**. Right: live pass preview with QR and its **short code** beneath.
Amber banner when the plan's card limit is reached, with Upgrade.

### 8.11 Customers
Search by card number, name or phone · card filter · **Export CSV**.
Table: **Card number** (mono) · Customer (avatar + View) · Card · **Progress** (`2/5` + bar) ·
Visits · Rewards · Last visit. Footer: "showing N of N customers".

### 8.12 Notifications
Tabs **Send** · **Automated**. Card selector, live recipient count.
**Green advisory**: too many notifications push customers to mute or delete the card.
Message textarea, **150-character cap with a counter**. Send disabled while empty.
Automated types: **welcome · birthday · win-back**.

> **Shipped, 2026-08-04.** `GET/POST /notifications` — owner session only
> (`requireMerchant()`, same as every other merchant route; a staff PIN
> session is simply invisible to it, see `apps/demo/test/notificationsHttp.test.ts`).
> **Send**: card selector with a live recipient count
> (`GET /notifications/recipient-count`), a 150-character-capped textarea with
> a visible counter, and the green advisory above, word for word, in both
> languages. Submitting enqueues via `apps/demo/broadcast.ts`'s
> `enqueueBroadcast()` and returns immediately — see §2's 2026-08-04 note for
> the Postgres-backed queue this rests on — then polls
> `GET /notifications/jobs/:id` to show queued/sending/sent with live counts.
> Broadcasts are also rate-limited per merchant (5 / 10 minutes) so a mistake
> cannot fire fifty in a minute. **Automated**: **welcome** is built end to
> end — it fires from `handleIssuePass`/`handleIssueGooglePass` on a genuine
> new enrolment (never a reused pass), through the same queue a manual Send
> uses. **Birthday** and **win-back** are shown in the UI, clearly marked "not
> yet scheduled" — no trigger exists for either; `BroadcastJob.kind` reserves
> the two values but nothing ever creates a job with them.
>
> The one part of this easy to get subtly wrong (§18 item 5, §9.3): a Wallet
> push carries no content, so the banner comes from `Pass`'s "msg"/"NEWS"
> field (`apps/demo/passContent.ts` — `storeCard.backFields`'s first entry as
> of the §9.1 2026-08-04 revision, `auxiliaryFields` before it) —
> `changeMessage` on a field whose *value* changed, which fires identically
> whether the field is a front row or a back one. Re-sending identical text
> would normally show nothing; `apps/demo/broadcast.ts`'s `enqueueBroadcast()`
> appends one `invisibleChangeMarker()` call **once per job, at enqueue time**
> (not per push, not per retry) so a repeated identical broadcast still banks
> a banner, while a retried push re-writes the *same* already-marked text and
> never re-shows a banner a device already caught up on.

### 8.13 Settings
Business profile · **Billing & subscription** → Manage billing ·
**Staff management** — *"add staff and give them a PIN to open the stamp screen in a
browser — no app"* · **Work locations** — *"customers are notified when they come near your
location"*, counter `0 / 1`, empty state · **Products & services**.

> **Shipped, 2026-08-04.** Staff PINs and location reminders are both live. Two
> deliberate placement decisions, neither stated explicitly above:
>
> 1. **Location reminders live on each card's own edit page** (`/cards/:id/edit`), not
>    on `GET /settings` — `Card.locations` is a per-card column (§9.1/§9.4), and the
>    card edit page is already this app's "settings for one card, always editable,
>    cache-invalidating on save" surface (the same page that owns colours, images,
>    labels). A merchant with several cards can give each its own geofences. `GET
>    /settings` carries staff management only, since `Staff` is merchant-scoped, not
>    per-card.
> 2. **The staff PIN sign-in screen asks for the business email, not just a PIN** —
>    there is no per-merchant URL for `/stamp` to identify *whose* staff list a bare
>    4-6 digit PIN should be checked against, so it asks the same way the owner's own
>    sign-in form does. Rate-limited both per business email (8/15min) and per IP
>    (30/15min) — see `apps/demo/staff.ts`'s `findStaffByPin` and
>    `apps/demo/server.ts`'s `staffPinLimiterByKey`/`staffPinLimiterByIp`.
>
> A staff PIN session (`apps/demo/staffAuth.ts`, cookie `lnx-staff`, separate table
> `StaffSession`, 12-hour TTL) opens only `GET /stamp` and `POST /api/stamp` — every
> other merchant route's `requireMerchant()` only ever reads the `lnx-session` cookie,
> so a staff session is simply invisible to it and 302s to `/signin` exactly as if
> there were no session at all. `StampEvent.staffId` (nullable, `onDelete: SetNull`)
> records which staff member recorded a stamp; null means the owner did.
> `apps/demo/test/staffScoping.test.ts` proves the refusal, one test per route.

### 8.14 Reports
Range chips 30/60/90 · **Export report**.
Four KPI tiles: Customers · Stamps today · Rewards this week · Revenue today.
**Customer funnel** — horizontal bars: registered → +stamp → 50% → reward.
Stamps by weekday · visits over time · best sellers · loyalty-driven revenue ·
**top customers** table. Empty states read "no data".

### 8.15 Stamp screen — our replacement for their app
Browser camera scanner over `getUserMedia`, decoding frames with a **WASM QR decoder**
(`zxing-wasm` or `jsQR`, ~40 KB), with a manual paste fallback.

> **Do not rely on `BarcodeDetector`.** Measured against MDN compat data: it works on
> Chrome Android and Chrome macOS/ChromeOS only. It is **absent on iOS and iPadOS**
> (Safari hides it behind a `Shape Detection API` preference), absent in every Firefox,
> and absent in Chrome on Windows and Linux. A café stamping on an iPad — a common
> setup — would fall through to typing codes by hand, which is worse than the competitor
> app we are displacing. `BarcodeDetector` may be used as a fast path where present, but
> the WASM decoder is the one that must always work.
Result banner: green on success (`✓ Stamped — 3/8`), amber-red on the 24h guard.
Opened by staff with a PIN.

### 8.16 Customer enrol page — the highest-value page
Full-bleed **card background colour** (the merchant's, not ours):
1. Merchant logo
2. **The reward as the headline**
3. Two supporting lines: what to do, and the goal
4. Fields **as configured by the issuance form builder** — default to optional
5. Consent checkbox with links to terms and the data policy
6. **Add to Apple / Google Wallet**, platform-detected
7. **"How it works"** — four numbered steps
8. "Powered by LoyaNexa"

> Competitors force name and phone. **We make fields configurable and default to optional.**
> Every required field costs enrolments.

---

## 9 · The pass

```
header strip: logo + business name
cover band  : image with the stamp circles overlaid
two fields  : REWARDS · 0 rewards        STAMPS REMAINING · 4 stamps
QR          : white box, short code printed beneath
```

Show **stamps remaining**, not stamps collected — a countdown reads as closer to the goal.

### 9.1 pass.json shape
```json
{ "formatVersion":1, "passTypeIdentifier":"pass.com.loyanexa.loyalty",
  "teamIdentifier":"…", "serialNumber":"<serial>", "organizationName":"<merchant>",
  "logoText":"<company if shown>", "backgroundColor":"rgb(…)", "foregroundColor":"rgb(…)",
  "labelColor":"rgb(…)",
  "storeCard":{
    "headerFields":[{"key":"stamps","label":"STAMPS","value":"3"}],
    "primaryFields":[],
    "secondaryFields":[{"key":"reward","label":"REWARD :","value":"Free coffee"}],
    "backFields":[
      {"key":"msg","label":"NEWS","value":"…","changeMessage":"%@"},
      terms, website, extraText, customerName ] },
  "barcodes":[{"format":"PKBarcodeFormatQR","message":"<serial>",
               "messageEncoding":"iso-8859-1","altText":"scan here"}],
  "locations":[{"latitude":…,"longitude":…,"relevantText":"You're near <shop>!"}],
  "maxDistance":100,
  "webServiceURL":"https://api.loyanexa.com/apple",
  "authenticationToken":"<per-pass token>" }
```

> **Revised, 2026-08-04.** The `"msg"`/`"NEWS"` broadcast field moved from
> `storeCard.auxiliaryFields` (shown in an earlier revision of this shape) into
> `storeCard.backFields`, as its first entry, ahead of the terms text. Apple
> renders `auxiliaryFields` as a third row on the card **face**, directly under
> reward/stamps-remaining — the owner looked at his own pass in Apple Wallet
> and pointed out that a broadcast message living there permanently is
> clutter, not a notification, the moment it stops being new: "the
> notification should show as notifications outside, not be stuck in the card
> itself." `backFields` is not rendered on the face at all — the customer sees
> it only after tapping in. This is safe specifically because `changeMessage`
> (§9.3/§18 item 5 — what actually puts text on the lock screen; the push
> itself carries none) fires on a **back** field's value change exactly the
> same as a front one. Moving the field changes nothing about whether the
> banner appears, only where the text lives afterward. See
> `apps/demo/passContent.ts`'s own dated doc comment for the implementation,
> and this section's own `secondaryFields`/`headerFields` split above, which
> is unchanged: `primaryFields` stays empty (§9.1's own reasoning: the strip
> renders behind it), `headerFields` carries stamps collected, `secondaryFields`
> carries reward and stamps remaining — the face now carries exactly those two
> rows and nothing else.
>
> A code-only shape change like this touches no `Card`/`Pass` row on its own,
> so it does not by itself invalidate the `.pkpass` cache
> (`apps/demo/pkpassCache.ts`'s key, or wake any device to re-poll (§9.3). The
> existing card-edit mechanism (`apps/demo/cardPush.ts`'s `pushCardDevices`,
> added alongside the cache-key fix, §9.3's 2026-08-03 note) is reused via a
> one-shot script, `scripts/repush-cards.ts`, run once after this ships: it
> bumps every `Card.updatedAt` (invalidating every affected pass's cache
> entry, the same way a design edit does) and wakes every registered device to
> re-poll immediately, so existing pass holders see the cleaned-up face
> without waiting for their next stamp or edit. No `changeMessage` fires for
> this alone — the message field's *value* did not change, only where it
> lives in the pass — so no lock-screen banner appears for the layout change
> itself, which is correct: nothing new happened worth a banner.

### 9.2 The stamp circles are an IMAGE, not text
They live in the pass **strip** (`strip.png`, `@2x`, `@3x`), generated server-side and
regenerated whenever the count changes. Canvas 375×144 pt → @3x is 1125×432 px.
Empty slot = hollow ring; filled = solid disc, **or the merchant's logo circularly masked**
when custom stamps are on — keep a thin rim so a pale logo still reads as a stamp.

A pure-JS PNG encoder (zlib + manual chunks) already exists and is proven — no native
dependencies, so `npm install` works on any host. **Port it as-is.**

### 9.3 Live updates
```
1. stamp recorded in Postgres
2. EMPTY APNs push to every registered device for that pass
3. device calls GET /apple/v1/devices/…/registrations?passesUpdatedSince=
4. server returns changed serials
5. device calls GET /apple/v1/passes/:passTypeId/:serial and re-downloads
6. iOS diffs the fields and shows the lock-screen banner
```
**The push carries no content.** The visible message comes from `changeMessage` on a field
whose value changed. **Trap:** sending identical text twice shows no banner — append an
invisible zero-width marker plus a timestamp to guarantee a change.
**Trap:** `webServiceURL` **must be HTTPS**. Apple refuses http silently; updates never
arrive with no error. Use ngrok in development.

> **Measured, 2026-08-03.** Two facts settled against Apple's real production APNs
> gateway with a real registered device token (nothing simulated, nothing assumed) —
> found while fixing a stale-`.pkpass`-after-a-card-edit regression in the rebuilt-pass
> cache (`apps/demo/pkpassCache.ts` / `apps/demo/server.ts`'s `PKPASS_STORE`, distinct
> from the strip cache in §10 below) and recorded here so nobody re-derives them:
>
> 1. **`apns-priority: 10` alongside `apns-push-type: background` is accepted for a
>    PassKit topic.** All four header combinations returned `200`:
>    ```
>    push-type=background  priority=10  -> 200   [153ms]
>    push-type=background  priority=5   -> 200   [145ms]
>    no push-type          priority=10  -> 200   [140ms]
>    no push-type          no priority  -> 200   [139ms]
>    ```
>    Apple's general APNs documentation says priority 10 is invalid for a background
>    push; that is not what the PassKit gateway does in practice. `packages/pass/src/apns.ts`
>    keeps priority 10 deliberately — it is what the 1-2 second target above wants —
>    as a verified choice now, not an assumed one.
> 2. **The certificate-mode mTLS round trip to Apple is ~140-155ms** on a warm HTTP/2
>    session, from `lhr`. That is the bulk of the "network layer" slice of the 1-2
>    second budget the paragraph above describes.

### 9.4 Location reminders are free and automatic
Geofences live **inside the pass** (max 10). The OS surfaces the card when the customer is
near. **No server call, no cost, and it keeps working if your backend is down.** Tell
merchants this plainly — it is one of the strongest selling points.

### 9.5 Google Wallet
No file, no signing — a JWT save link plus a `LoyaltyObject` PATCH. Until Publishing Access
is granted every pass carries a "Test" badge; that is expected.

### 9.6 Anti-fraud
**One stamp per card per 24 hours**, enforced **server-side** before any write.
Return HTTP 429 with a translated message.

---

## 10 · Performance — measured, not guessed

### Strip generation is the bottleneck
| Operation | Time |
|---|---|
| strip @2x with logo | 27 ms |
| strip @3x with logo | 55 ms |
| **full pass (three densities)** | **93 ms → 11 passes/sec/core** |

### The cache fixes it — content-addressed
A strip depends only on `(goal, filled, colours, logo, scale)` — **never on which customer
holds the pass**. An 8-stamp card has **9 possible images**, not one per customer.

5,000 pass fetches after one broadcast:

| | time | images generated |
|---|---|---|
| uncached | **122 s** | 5,000 |
| cached | **0.40 s** | 9 |
| | **455× faster** | 99.8% hit rate |

Verified: cached bytes byte-identical to a fresh render; different logos do not collide;
the store is bounded (LRU).

```ts
export interface StripStore {          // MemoryStore in dev, Redis in production
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, value: Buffer): Promise<void>;
}
```

**Without this cache you need roughly twenty servers instead of one.**

### Other measured facts
- 200,000 passes inserted: **zero serial collisions**, stats query **27 ms**,
  single pass lookup **3 ms**
- Broadcasts must be **queued** — 10,000 pushes then 10,000 fetches inside a request
  handler will time out and hammer the database
- **Logos must live in R2**, not as data URLs in the database — rows reach megabytes and
  are read on every query

---

## 11 · Database (Prisma)

```prisma
model Merchant {
  id            String    @id @default(cuid())
  firebaseUid   String    @unique
  email         String    @unique
  name          String
  locale        String    @default("ar")
  plan          Plan      @default(STARTER)
  stripeCustId  String?
  subStatus     String    @default("trialing")
  trialEndsAt   DateTime?
  cards         Card[]
  createdAt     DateTime  @default(now())
  @@index([firebaseUid])
}

model Card {
  id             String   @id @default(cuid())
  merchantId     String
  merchant       Merchant @relation(fields:[merchantId], references:[id], onDelete: Cascade)
  slot           Int
  linkCode       Int      @unique          // loyn.me/11819
  linkAlias      String?  @unique          // loyn.me/juixy
  shortCode      String   @unique          // printed under the QR, e.g. 8804DD32
  name           String
  logoIconUrl    String?                   // R2 URL — never a data URL
  coverUrl       String?
  stampsGoal     Int      @default(8)
  starterStamps  Int      @default(0)
  stampShape     String   @default("circle")
  customStamps   Boolean  @default(false)
  bgColor        String
  fgColor        String
  stampActive    String
  stampInactive  String
  labelStamps    String   @default("")     // custom label, max 16 chars
  labelRewards   String   @default("")
  lang           String   @default("ar")
  expiryType     String   @default("unlimited")   // unlimited | duration | fixed
  expiryDays     Int?
  expiryDate     DateTime?
  rewardText     String
  formFields     Json     @default("[\"name\",\"phone\"]")
  locations      Json     @default("[]")   // max 10 — Apple's limit
  active         Boolean  @default(false)
  passes         Pass[]
  createdAt      DateTime @default(now())
  @@unique([merchantId, slot])
  @@index([linkCode])
  @@index([linkAlias])
}

model Pass {
  id            String    @id @default(cuid())
  serial        String    @unique          // 18 chars, unguessable — the card QR payload
  shortCode     String    @unique          // shown in the customers table
  cardId        String
  card          Card      @relation(fields:[cardId], references:[id], onDelete: Cascade)
  merchantId    String
  authToken     String
  custName      String    @default("")
  custEmail     String    @default("")
  custPhone     String    @default("")
  custBirthday  DateTime?
  stamps        Int       @default(0)
  totalStamps   Int       @default(0)
  rewards       Int       @default(0)
  message       String    @default("")
  platform      String    @default("")
  lastStampAt   DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  devices       Device[]
  @@index([cardId])
  @@index([merchantId, lastStampAt])       // powers the "gone quiet" query
  @@index([updatedAt])                     // powers PassKit device polling
}

model Device {
  deviceId   String
  passSerial String
  pushToken  String
  @@id([deviceId, passSerial])
  @@index([passSerial])
}

model StampEvent {
  id         BigInt   @id @default(autoincrement())
  merchantId String
  cardId     String
  serial     String
  kind       EventKind
  source     String   @default("browser")  // browser | remote | api
  at         DateTime @default(now())
  @@index([merchantId, at])
  @@index([cardId, kind])
}

model LinkCounter { id Int @id @default(1)  value Int @default(10000) }

enum Plan      { STARTER GROWTH PRO }
enum EventKind { ENROLL STAMP REWARD REDEEM }
```

**Do not remove these indexes.** `Pass[merchantId, lastStampAt]` makes the at-risk query
fast at a million rows; `Pass[updatedAt]` is hit by every Apple device poll;
`Card[linkCode]` resolves the short link on every scan.

---

## 12 · API

Auth: Firebase ID token in `Authorization: Bearer …`, verified server-side and mapped to a
Merchant by `firebaseUid`.

### Merchant (authenticated)
```
GET    /api/me                        PATCH  /api/me
GET    /api/cards                     POST   /api/cards
PUT    /api/cards/:id                 DELETE /api/cards/:id
POST   /api/cards/:id/activate        POST   /api/cards/:id/rename-link
POST   /api/stamp                     POST   /api/messages/broadcast
GET    /api/customers                 GET    /api/stats
GET    /api/export.csv                POST   /api/uploads/logo
POST   /api/billing/checkout          POST   /api/billing/portal
```

### Public (no auth)
```
GET    /:code                         short link → 302 to the enrol page
GET    /api/public/:code              card design for the enrol page
POST   /api/public/:code/pass         issue a pass
GET    /api/pass/:serial/apple        signed .pkpass
GET    /api/pass/:serial/strip.png    stamp image (cached)
```

### Apple PassKit web service — Apple calls these, paths are fixed by Apple
```
POST   /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial
GET    /apple/v1/devices/:deviceId/registrations/:passTypeId?passesUpdatedSince=
GET    /apple/v1/passes/:passTypeId/:serial
DELETE /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial
POST   /apple/v1/log
```
Auth header: `Authorization: ApplePass <token>` — a unique token per pass.

### Webhooks
```
POST   /webhooks/stripe   checkout.session.completed · subscription.updated · .deleted
```

**Routing order:** register the short-link catch-all `GET /:code` **last**, or it shadows
every API route.

---

## 13 · Bilingual and RTL

- **Logical CSS properties throughout** — `margin-inline-start`, `inset-inline-end`,
  `border-inline-end`. Never `left` / `right`. Mirroring then costs nothing.
- **Arabic-Indic numerals** everywhere including prices, tables, progress and chart axes:
  `n(v) = LANG==='ar' ? String(v).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[+d]) : String(v)`
- **Arabic calendar** in the date picker; dates format per locale (`٢ أغسطس ٢٠٢٦`)
- `letter-spacing: 0` under `lang=ar` (§4)
- Weight scale switches by script (§4)
- **Server error messages translated too** — read the `lang` cookie and respond in kind
- Language and theme persist in **cookies, never localStorage**, so the server can read them
- **Never translate merchant-authored text** — card name, reward, terms stay as written
- Both dictionaries hold identical key sets, with a **CI check that fails on a gap**
  (a missing key renders as a blank element — silent and easy to ship)

---

## 14 · Pricing

Three plans, all features included; the difference is capacity.

| | Starter | Growth ⭐ | Pro |
|---|---|---|---|
| Monthly | £19 | £39 | £69 |
| Annual | £190 | £390 | £690 |
| Loyalty cards | 1 | 3 | 10 |
| Locations | 1 | 3 | 10 |
| Staff accounts | — | 10 | 50 |
| Unlimited customers · notifications | ✓ | ✓ | ✓ |
| Location reminders · stats · anti-fraud · logo stamps | ✓ | ✓ | ✓ |
| Targeted messages · data export | — | ✓ | ✓ |
| Automated messages · API | — | — | ✓ |

Seven-day free trial, no card details. Build the matrix data-driven so prices are one constant.

---

## 15 · Build order

**Phase 0 — start now, external waiting (3–7 days)**
- [ ] Apple Developer Program ($99/yr) under the company name
- [ ] Pass Type ID + certificate → `signerCert.pem`, `signerKey.pem`
- [ ] APNs auth key `.p8` — **downloads once**; put it in a password manager immediately
- [ ] Apple WWDR G4 → `wwdr.pem`
- [ ] Google Wallet Issuer + request **Publishing Access**
- [ ] Short domain (e.g. `loyn.me`) + app domain
- [ ] Firebase project · Stripe account

**Phase 1 (week 1)** — monorepo, Prisma schema, Docker (Postgres + Redis), CI running
`tsc --noEmit` and the i18n parity check

**Phase 2 (week 2)** — port the proven services: `stripImage`, `stripCache`, `applePass`,
`googlePass`, `apns`, `qr`, i18n dictionaries. **Land both fixes here:** logos to R2,
strip cache on Redis

**Phase 3 (week 3)** — Firebase auth, onboarding, setup checklist, Stripe + **webhooks**

**Phase 4 (weeks 3–4, longest task)** — `.pkpass` signing, the four PassKit endpoints,
APNs with a reused HTTP/2 session, Google Wallet, strips at three densities, geofences

**Phase 5 (week 4)** — BullMQ broadcast worker, rate-limited and retried

**Phase 6 (weeks 4–5)** — Next.js landing + dashboard; enrol page stays plain HTML

**Phase 7 — before the first paying merchant**
- [ ] HTTPS + HSTS everywhere
- [ ] Rate-limit `POST /api/stamp` and the public enrol endpoint
- [ ] pino logging + Sentry
- [ ] Daily Postgres backups, **restore tested at least once**
- [ ] `certs/`, `.env`, `*.db` in `.gitignore` — verify before the first commit
- [ ] Calendar reminder at 11 months: **Apple certificates expire yearly**; expiry stops
      new passes being issued while existing passes keep working — a silent failure
- [ ] Privacy policy + terms (GDPR — you process customer names and emails)
- [ ] Pilot with 5–10 merchants free

**Realistic total: 6–8 weeks.**

---

## 16 · Running cost at a million passes

| Item | Monthly |
|---|---|
| Fly.io — 2 instances | ~£25 |
| Postgres | ~£20 |
| Redis | ~£8 |
| Cloudflare R2 | ~£3 |
| Firebase Auth | £0 |
| **Total** | **~£56** |

At 1,000 merchants × £25 that is £25,000 revenue — infrastructure under 0.25%.

---

## 17 · Conventions

- **TypeScript strict** plus `noUncheckedIndexedAccess`
- Row types mirror SQL column names exactly, so a typo is a compile error
- No native-dependency packages in the image pipeline (the PNG encoder is pure JS on purpose)
- Every merchant-scoped query filters by `merchantId` — never trust a client-supplied id
- Secrets from environment only; never commit `certs/`
- Serials: 18 random base64url chars — verified collision-free across 200k inserts
- Short link codes: atomic counter starting at 10000
- **QR codes must be real and scannable** — a verified pure-JS encoder already exists
- **Never use `localStorage` or `sessionStorage`** — cookies only

---

## 18 · The ten things most likely to hurt you, ranked

1. **Skipping the strip cache.** 455× measured. Nothing else is close.
2. **Leaving logos in the database.** Rows become megabytes; every query pays.
3. **Running wallet work on serverless.** Cold starts plus rebuilt TLS make APNs slow and
   unreliable, and you will blame the wrong layer for weeks.
4. **`webServiceURL` over http.** Apple fails silently; live updates never arrive.
5. **Re-sending identical push text.** No field changes, so no banner appears.
6. **Fanning out APNs inside a request handler.** One broadcast times out the request.
7. **Putting React on the enrol page.** 4 KB becomes 150 KB on café wifi, and enrolment —
   the metric the business depends on — drops.
8. **Letter-spacing on Arabic.** Breaks letter joining.
9. **Forgetting the Apple certificate renewal.** Silent failure to issue new passes.
10. **Registering the short-link catch-all before the API routes.** It shadows everything.

---

## 19 · Designs settled — but the code does **not** exist

> **Correction, 2026-08-02.** This section previously read "already proven — port, do not
> rebuild". That is wrong and it misled planning. **None of the code below exists in this
> repository or anywhere else.** The prototype contains only a canvas `qrMatrix`/`drawQR`.
> Treat every item as a from-scratch build whose *design* is settled, not as an asset to
> copy. Estimates that assume porting will be badly wrong.

- Pure-JS PNG encoder for stamp strips, including logo-as-stamp circular masking
- QR encoder — must be verified byte-identical against a reference implementation
- Correct `pass.json` field layout
- The four PassKit web-service endpoints
- 24-hour anti-fraud limit
- Short-link routing with rename support
- Bilingual dictionaries with verified key parity, RTL layout, Arabic-Indic numerals
- Browser camera stamping — see §8.15; **not** `BarcodeDetector`, which is unavailable on
  iOS, Firefox and Windows Chrome
- The complete flow as a **click-through prototype** (`prototype/index.html`) — a
  behavioural reference, not tested production code
