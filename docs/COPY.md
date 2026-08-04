# LoyaNexa — copy style guide

One page of decisions so the next person doesn't reintroduce what this pass fixed. Applies to
`apps/demo/public/index.html`'s `T` dictionary, `packages/i18n/src/{en,ar}.ts`, and any new
customer- or merchant-facing string, including Wallet pass field labels.

---

## 1 · Terminology — pick one word, use it everywhere

| Concept | English | Arabic | Not this |
|---|---|---|---|
| The loyalty stamp | **stamp** | **ختم** / **أختام** | point, punch — except the landing page's own "points card" is a *second*, genuinely different card type (see §4) and keeps نقاط/points for that one case |
| What the customer carries | **card** (never "pass" in customer-facing copy) | **بطاقة** | كرت (colloquial loanword — found and fixed twice in the pricing table) |
| What they earn | **reward** | **مكافأة** / **مكافآت** | جائزة — never used, keep it that way |
| The person visiting | **customer** | **عميل** / **عملاء** | user, member; زبون/زبائن (colloquial — found and fixed ten times, mostly in the landing page's later sections) |
| The merchant's business | **merchant** in admin/API copy; **your business** when addressing them directly | **متجر** (shop) in product-designer copy, **النشاط التجاري** in account/sign-up copy | تاجر only for the literal account-role label (stamp screen notice) |
| The technical Wallet object | **pass** is correct and expected — it's Apple/Google's own term (`pass.json`, "Apple Wallet pass") | **بطاقة** still, since the customer never sees the word "pass" | — |
| The company operating the platform | **the company** (used once, in the auto-generated terms — BUILD.md §8.6) | **الشركة** | — |

If a new string needs one of these concepts, reuse the existing key rather than writing a new
phrase — `npm run test:i18n` only catches missing keys, not disagreeing synonyms.

## 2 · English voice

- **British spelling.** colour, organisation, personalise, programme, licence. Caught and fixed:
  "programs" → "programmes" (hero copy and `<meta description>`).
- **Sentence case for headings.** Not Title Case.
- **No exclamation marks, no hyperbole.** No "revolutionary", "seamless", "game-changing" — the
  landing page was already clean of these; keep it that way.
- **Numbers as digits**, not spelled out, matching the house style already used for "7-day trial",
  "3 minutes", "47 customers" etc. Caught and fixed: "two days" next to "the 7 days" in the same
  sentence, "eleven minutes" next to "7 days" in the same sentence, "three branches" vs the same
  fact rendered as "3 branches" two screens later. Sentence-initial "One screen…" style openers are
  the one deliberate exception — a digit reads badly as the first word of a sentence.
- **Terminology**, per §1.

## 3 · Arabic — the part that needs real care

- **Hamza placement (أ / إ / ا)**, **taa marbuta vs haa (ة / ه)**, **alif maqsura (ى / ي)** —
  spot-checked across both dictionaries; the pre-existing text was largely correct. The errors
  that were there were subtler: colloquial word choice (§1), one wrong word-order on a definite
  numeral ("السبعة أيام" → correct order "الأيام السبعة" — Arabic places the numeral *after* a
  definite noun for 3–10, e.g. الأيام السبعة not السبعة أيام), and one outright wrong verb
  ("لم تحدث بعد" for "Never" in a last-visit column → "أبدًا").
- **Write Arabic, not translated English.** Idioms don't carry word-for-word. Example fixed:
  `designerEconomicsHeading` "الاقتصاديات" (literally "economics", reads like an academic subject)
  → "القواعد الاقتصادية" ("the economic rules" — what the heading is actually grouping).
- **Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩)** everywhere a number is customer- or merchant-facing —
  `packages/i18n/src/index.ts`'s `arabicDigits()` does the conversion, and the landing page's own
  `n()` helper does the same. Two classes of bug fixed this pass:
  - **Baked into a static string**: "16 حرفًا", "10 أحرف", "80 حرفًا", "120 حرفًا" in
    `packages/i18n/src/ar.ts` were plain Western digits sitting inside otherwise-Arabic sentences.
    Now ١٦ / ١٠ / ٨٠ / ١٢٠.
  - **Leaked through an interpolated `{placeholder}`**: `t(lang, 'key', { count: String(n) })`
    passes Western digits straight through even when `lang === 'ar'`, because `t()` only
    substitutes — it never converts. Four call sites in `apps/demo/server.ts` did this
    (`newCardGoalRange`, `lockCustomersRegistered` ×2, `customersFooter`). Fixed by wrapping the
    value in `arabicDigits(value, lang)` before it reaches `t()`. **This is the bug shape to watch
    for in review**: any `t(lang, key, { x: String(n) })` should almost always be
    `t(lang, key, { x: arabicDigits(n, lang) })` instead.
- **Never apply `letter-spacing` or `text-transform` to Arabic** (BUILD.md §4 — tracking breaks
  letter joining). The landing page had per-component `html[lang="ar"] .foo{letter-spacing:0}`
  overrides on some elements but not all of them (two components softened tracking to `.04em`/
  `.06em` instead of zeroing it, several more had no override at all). Fixed with one rule instead
  of chasing each component:
  ```css
  html[lang="ar"] *{letter-spacing:0!important}
  ```
  placed once, near the top of `apps/demo/public/index.html`'s stylesheet. The per-component
  overrides are now redundant but harmless — left in place rather than removed, to keep this a
  copy fix and not a CSS refactor.
- **RTL layout**: logical CSS properties (`margin-inline-start`, not `left`/`right`) were already
  used throughout; nothing needed changing there. Parentheses and punctuation mirror automatically
  under `dir="rtl"` via the Unicode bidi algorithm — don't hand-flip them.

## 4 · Deliberate exceptions — don't "fix" these

- **"Points" and "points card"** on the landing page (pricing table, FAQ, the demo dashboard mock)
  are a second, real card type distinct from the stamp card — "Both plans include two design
  slots, so you can run a stamp card and a points card side by side" (FAQ). Not a terminology slip.
- **"512×512", pixel dimensions, hex codes, short codes (`AB12CD34`)** stay in Western digits even
  in Arabic sentences — they're technical specs and reference codes, not quantities being read as
  numbers.
- **Merchant-authored text is never translated or reworded** — card name, reward text, custom
  terms (BUILD.md §13). `buildPassContentFor()`'s `card.rewardText` is interpolated into a
  translated sentence, never passed through `t()` itself; there's a regression test for this
  (`apps/demo/test/passContent.test.ts`).

## 5 · Where copy lives, and what still needs a key

Every string a customer or merchant can see should resolve through `t(lang, key, vars)` from
`@loyanexa/i18n`, or (landing page only) `T[lang].key`. Two whole surfaces were found rendering
English unconditionally, regardless of `card.lang` — both fixed this pass, both now covered by a
regression test:

- **The Apple Wallet pass itself** (`apps/demo/passContent.ts`) — `REWARD`, `STAMPS REMAINING`,
  the header stamp count, and the six auto-generated terms lines (BUILD.md §8.6) all hardcoded
  English labels. Now keyed under `pass*` in the dictionaries and driven by `card.lang`.
- **The Google Wallet card** (`packages/pass/src/googleWallet.ts`'s `saveLink()`) hardcoded the
  `accountName` fallback to the English word "Member" (also a terminology violation — §1) whenever
  no customer name was given, which is the common case since BUILD.md §8.16 defaults every enrol
  field to optional. `saveLink()` now takes an optional `{ accountNameFallback, balanceText }` —
  `packages/pass` deliberately still has no i18n dependency of its own, so `apps/demo/server.ts`
  resolves both from `card.lang` and passes them in, the same "app layer resolves language,
  package layer stays language-agnostic" split `passContent.ts` already follows.
  - **Known follow-up, not fixed this pass**: `updateLoyaltyObject()` — the PATCH that updates the
    balance on an *already-saved* Google Wallet card after a later stamp — still writes
    `"{stamps} / {goal}"` in Western digits regardless of the card's language. Fixing it means
    threading `card.lang` through `apps/demo/stamp.ts`'s `applyStamp()` → `StampOutcome` →
    `pushPassUpdate()` → `pushGoogleWalletUpdate()`, which touches the fraud-sensitive stamp
    transaction path and its existing test coverage. Left alone deliberately rather than risking
    that path under time pressure for a digit-script nicety on a fire-and-forget background sync
    (Google re-renders the saved card from this data, but the customer isn't shown an error either
    way). Worth doing as its own small follow-up.
- **The customer enrol page** (`apps/demo/server.ts`'s `renderEnrolPage`) — hardcoded
  `<html lang="en">` and every string on the page, including both wallet buttons. BUILD.md §8.16
  calls this "the highest-value page"; it was the one page silently ignoring the card's own
  language. Now keyed under `enrol*`/`wallet*` and driven by `card.lang`, matching the pattern
  already used correctly by the sign-in page and the stamp screen.

If you add a new customer-facing surface, follow that same pattern from the start: derive
`lang` from `card.lang` (or the `lnx-lang` cookie via `resolveLang()`), set
`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`, and pull every string through
`t()`. `npm run test:i18n` only checks the two dictionaries agree on keys — it cannot catch a
render path that never calls `t()` in the first place.
