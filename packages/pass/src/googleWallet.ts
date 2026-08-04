// packages/pass/src/googleWallet.ts
//
// The Google Wallet half of live pass updates (BUILD.md §9.5). Unlike Apple
// Wallet, there is no file to build and no binary artifact to sign: a
// customer "adds" the card by opening a `https://pay.google.com/gp/v/save/<jwt>`
// link whose JWT payload carries the `LoyaltyObject` itself — Google creates
// the object (and shows it) the moment the link is opened and saved. Until
// the issuer is granted Publishing Access every object shows a "Test" badge
// — that is expected, not a bug (BUILD.md §9.5).
//
// Two Google resources this file manages:
//   - LoyaltyClass — one per merchant card (`<issuerId>.card_<cardId>`), the
//     shared "template" (name, colours, logo) every customer's card for
//     that merchant renders against. ensureLoyaltyClass() creates it once
//     and patches it on every later call, so re-running it is always safe.
//   - LoyaltyObject — one per issued pass (`<issuerId>.pass_<serial>`), the
//     actual per-customer card (stamp balance, barcode). saveLink() builds
//     one inline in a JWT for the customer to save; updateLoyaltyObject()
//     PATCHes an already-saved object's balance after a stamp lands.
//
// No new npm dependencies: node:crypto signs both the OAuth2 assertion JWT
// and the "save to wallet" JWT (both RS256 — Google Wallet requires a
// service account, which is always an RSA key, so unlike apns.ts's ES256
// there is no P1363-vs-DER trap here: RSASSA-PKCS1-v1_5 is node:crypto's
// default padding for an RSA key, which is exactly what RS256 is), and
// global fetch makes every HTTP call — no Google API client library.

import crypto from 'node:crypto';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const WALLET_API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';
const WALLET_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

/**
 * Google's token endpoint hands back an access token good for ~3600s.
 * Refresh with a margin before it actually expires — same principle as
 * ApnsClient's provider-JWT cache in apns.ts, just a shorter-lived token
 * behind a completely different auth scheme (OAuth2 client-credentials via
 * a service account, not a long-lived signed JWT presented directly).
 */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')).toString('base64url');
}

/** Raised for any non-2xx response from the Wallet Objects REST API, carrying the real status/body rather than swallowing it. */
export class GoogleWalletApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(action: string, status: number, body: string) {
    super(`Google Wallet ${action} failed: ${status} ${body}`);
    this.name = 'GoogleWalletApiError';
    this.status = status;
    this.body = body;
  }
}

export interface GoogleWalletConfig {
  /** GOOGLE_ISSUER_ID — the numeric issuer id assigned by the Google Pay & Wallet Console. */
  issuerId: string;
  /** The service account's `client_email` — becomes the signing JWTs' `iss`. */
  serviceAccountEmail: string;
  /** The service account's `private_key` (PEM, PKCS8/RSA) — never a file path, matching resolveGoogleServiceAccount()'s contract in credentials.ts. */
  privateKeyPem: string;
  /**
   * The app's public HTTPS origin (no trailing slash), e.g.
   * `https://loyanexa-demo.fly.dev`. Used both for the class's
   * `programLogo` (must be a publicly reachable HTTPS URL — Google fetches
   * it during review) and as the save-link JWT's `origins` entry.
   */
  publicBaseUrl: string;
}

/** The subset of Card fields ensureLoyaltyClass() needs. */
export interface LoyaltyClassCard {
  id: string;
  name: string;
  /** Hex, e.g. "#203757" — becomes the class's `hexBackgroundColor`. */
  bgColor: string;
}

export type EnsureLoyaltyClassResult =
  | { classId: string; status: 201 } // just created
  | { classId: string; status: 200 }; // already existed, patched

/** The subset of Pass fields saveLink()/updateLoyaltyObject() need. */
export interface LoyaltyObjectPass {
  /** Pass.serial — becomes the object's id suffix, its `accountId`, and the QR barcode value (the same value Apple's pass QR and the merchant stamp screen already use). */
  serial: string;
  /** Current stamp count for this pass. */
  stamps: number;
  /** Optional customer name (Pass.custName) — becomes `accountName`, matching Apple's pass, which shows nothing customer-specific when name was left blank. */
  custName?: string;
}

/** The subset of Card fields saveLink() needs, alongside LoyaltyClassCard.id to build the matching classId. */
export interface LoyaltyObjectCard {
  id: string;
  stampsGoal: number;
}

export type UpdateLoyaltyObjectResult =
  | { ok: true }
  /** The object was never created — this pass was never added to Google Wallet. Not an error: every stamp fires this update regardless of which wallet(s) the customer actually used (BUILD.md §18 item 6 — fire-and-forget, same as the APNs push). */
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'error'; status: number; body: string };

/**
 * One Google Wallet issuer connection: caches its OAuth2 access token and
 * exposes the three operations BUILD.md §9.5 needs. Construct one instance
 * from env config and keep it — like ApnsClient, re-authenticating per call
 * defeats the point of caching the token at all.
 */
export class GoogleWalletClient {
  readonly #config: GoogleWalletConfig;
  readonly #privateKey: crypto.KeyObject;
  #cachedAccessToken: { token: string; expiresAt: number } | undefined;

  constructor(config: GoogleWalletConfig) {
    this.#config = config;
    this.#privateKey = crypto.createPrivateKey({ key: config.privateKeyPem, format: 'pem' });
  }

  #classId(cardId: string): string {
    return `${this.#config.issuerId}.card_${cardId}`;
  }

  #objectId(serial: string): string {
    return `${this.#config.issuerId}.pass_${serial}`;
  }

  /** Signs an RS256 JWT with the service-account key. Shared by the OAuth2 assertion and the "save to wallet" JWT — the two differ only in claims. */
  #signJwt(claims: Record<string, unknown>): string {
    const header = { alg: 'RS256', typ: 'JWT' };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), this.#privateKey);
    return `${signingInput}.${base64url(signature)}`;
  }

  /**
   * Returns a cached OAuth2 access token, minting a new one via the
   * service-account JWT-bearer flow only when the cached one is missing or
   * within {@link ACCESS_TOKEN_REFRESH_MARGIN_MS} of expiring. This is the
   * only method in this class that makes a network call unrelated to the
   * Wallet Objects API itself — every other method calls this first, then
   * calls Google's REST API with the bearer token it returns.
   */
  async #getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.#cachedAccessToken && now < this.#cachedAccessToken.expiresAt) {
      return this.#cachedAccessToken.token;
    }

    const iat = Math.floor(now / 1000);
    const assertion = this.#signJwt({
      iss: this.#config.serviceAccountEmail,
      scope: WALLET_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat,
      exp: iat + 3600,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) {
      throw new GoogleWalletApiError('OAuth2 token exchange', res.status, await res.text());
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.#cachedAccessToken = {
      token: json.access_token,
      expiresAt: now + json.expires_in * 1000 - ACCESS_TOKEN_REFRESH_MARGIN_MS,
    };
    return this.#cachedAccessToken.token;
  }

  /**
   * Creates the `LoyaltyClass` for `card` if it doesn't exist yet, or
   * patches it (colours/name/logo may have changed) if it does — GET then
   * insert-or-patch, the pattern Google's own docs recommend over blindly
   * inserting and handling the 409 it raises for an id that already exists.
   * Idempotent and safe to call before every save link is issued.
   */
  async ensureLoyaltyClass(card: LoyaltyClassCard): Promise<EnsureLoyaltyClassResult> {
    const classId = this.#classId(card.id);
    const accessToken = await this.#getAccessToken();
    const classResource = {
      id: classId,
      // Google's docs recommend a max of ~20 characters for issuerName
      // before it starts eliding — programName has no such limit. Our
      // schema has no separate "business name" field distinct from the
      // card's own name (the create-card form's own placeholder is a
      // business name, e.g. "Shami Bakery"), so both come from card.name,
      // exactly like Apple's pass reuses card.name for both
      // organizationName and logoText.
      issuerName: card.name.slice(0, 20),
      programName: card.name,
      hexBackgroundColor: card.bgColor,
      programLogo: { sourceUri: { uri: `${this.#config.publicBaseUrl}/logo-dark.png` } },
      // Every class starts here until the issuer is granted Publishing
      // Access (BUILD.md §9.5) — passes work fine, just carry a "Test"
      // badge. Never set this to APPROVED ourselves; only Google's review
      // does that.
      reviewStatus: 'UNDER_REVIEW',
    };

    const existing = await fetch(`${WALLET_API_BASE}/loyaltyClass/${classId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (existing.status === 404) {
      const inserted = await fetch(`${WALLET_API_BASE}/loyaltyClass`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(classResource),
      });
      if (!inserted.ok) {
        throw new GoogleWalletApiError('insert loyaltyClass', inserted.status, await inserted.text());
      }
      return { classId, status: 201 };
    }
    if (!existing.ok) {
      throw new GoogleWalletApiError('get loyaltyClass', existing.status, await existing.text());
    }

    const patched = await fetch(`${WALLET_API_BASE}/loyaltyClass/${classId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(classResource),
    });
    if (!patched.ok) {
      throw new GoogleWalletApiError('patch loyaltyClass', patched.status, await patched.text());
    }
    return { classId, status: 200 };
  }

  /**
   * Builds the `LoyaltyObject` for `pass` and returns the
   * `https://pay.google.com/gp/v/save/<jwt>` save link — the entire "no
   * file, no signing" flow BUILD.md §9.5 describes: the JWT itself carries
   * the object, so no prior server round-trip to create it is needed (the
   * class, referenced by `classId`, must already exist — call
   * {@link ensureLoyaltyClass} first). Pure and synchronous: signing a JWT
   * with a key already in memory needs no network call, unlike every other
   * method here.
   *
   * `accountName`/`loyaltyPoints.balance.string` are both customer-facing
   * text inside the actual Google Wallet card (BUILD.md §13), so this
   * package — which deliberately has no i18n dependency of its own, see
   * `LoyaltyObjectPass`/`LoyaltyObjectCard`'s doc comments — takes them
   * already localized via `opts`, rather than hardcoding English/Western
   * digits here. `opts` is optional so existing callers keep compiling;
   * the defaults below match the pre-existing behaviour except for the
   * word "Member", which this package's caller (apps/demo/server.ts) no
   * longer needs since every real caller now supplies `accountNameFallback`
   * itself (BUILD.md §13/docs/COPY.md — "customer", never "member").
   */
  saveLink(
    pass: LoyaltyObjectPass,
    card: LoyaltyObjectCard,
    opts: { accountNameFallback?: string; balanceText?: string } = {}
  ): string {
    const loyaltyObject = {
      id: this.#objectId(pass.serial),
      classId: this.#classId(card.id),
      state: 'ACTIVE',
      accountId: pass.serial,
      accountName: pass.custName?.trim() || opts.accountNameFallback || 'Customer',
      loyaltyPoints: { balance: { string: opts.balanceText ?? `${pass.stamps} / ${card.stampsGoal}` } },
      barcode: { type: 'QR_CODE', value: pass.serial },
    };

    const iat = Math.floor(Date.now() / 1000);
    const jwt = this.#signJwt({
      iss: this.#config.serviceAccountEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat,
      origins: [this.#config.publicBaseUrl],
      payload: { loyaltyObjects: [loyaltyObject] },
    });
    return `https://pay.google.com/gp/v/save/${jwt}`;
  }

  /**
   * PATCHes the balance on an already-saved `LoyaltyObject` so a stamp
   * shows up on Android — the Google-side counterpart to apns.ts's
   * `sendPush`. Unlike Apple, there is no device-registration step to
   * check first: Google syncs a saved object automatically once its data
   * changes server-side, so this is called for every stamp regardless of
   * which wallet(s) the customer actually used. `reason: 'not_found'`
   * covers the common case — the object was never created because this
   * pass was only ever added to Apple Wallet — and is not an error.
   *
   * `opts.balanceText`, when supplied, replaces the default `"{stamps} /
   * {goal}"` — customer-facing text (BUILD.md §13), so the same
   * "app layer resolves language, package layer stays language-agnostic"
   * split as {@link saveLink}'s own `opts` lets the caller localise it
   * (Arabic-Indic digits on an Arabic card) without this package taking an
   * i18n dependency of its own. Omitted, the default matches this method's
   * pre-existing (unlocalised) behaviour, so existing callers keep working.
   */
  async updateLoyaltyObject(
    serial: string,
    stamps: number,
    goal: number,
    opts: { balanceText?: string } = {}
  ): Promise<UpdateLoyaltyObjectResult> {
    const accessToken = await this.#getAccessToken();
    const objectId = this.#objectId(serial);
    const res = await fetch(`${WALLET_API_BASE}/loyaltyObject/${objectId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ loyaltyPoints: { balance: { string: opts.balanceText ?? `${stamps} / ${goal}` } } }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'error', status: res.status, body: await res.text() };
  }
}
