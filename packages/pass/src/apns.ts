// packages/pass/src/apns.ts
//
// The APNs half of live pass updates (BUILD.md §9.3 step 2, §18 items 3/6).
// A stamp landing in Postgres is invisible to the customer until something
// wakes their phone up — that's this file's only job: sign a token-based
// provider auth JWT and POST an empty `{}` push to Apple over a long-lived
// HTTP/2 connection.
//
// No new npm dependencies: node:crypto signs the ES256 JWT, node:http2 is
// the wire protocol APNs requires (HTTP/1.1 is not accepted on this
// endpoint).
//
// Two traps this file exists to avoid (BUILD.md §18 item 3, and the
// APNs provider-auth spec):
//   1. Rebuilding the HTTP/2 session per push. TLS handshake plus APNs'
//      own connection-establishment cost makes that slow, and hammering
//      Apple with fresh connections risks a rate limit. One session is
//      opened lazily and reused for every push; it's only rebuilt after an
//      error/close tears it down.
//   2. Regenerating the JWT per push. Apple rate-limits how often a given
//      key can mint a fresh provider token, and rejects tokens older than
//      an hour. The token is cached and only rebuilt after ~50 minutes.

import crypto from 'node:crypto';
import http2 from 'node:http2';

export interface ApnsConfig {
  /** The 10-character APNs Auth Key ID (APNS_KEY_ID) — becomes the JWT's `kid`. */
  keyId: string;
  /** The Apple Developer Team ID (APPLE_TEAM_ID) — becomes the JWT's `iss`. */
  teamId: string;
  /** PEM contents of the `.p8` signing key (PKCS8, EC P-256). Never a file path — see credentials.ts's resolveApnsKeyPem(). */
  privateKeyPem: string;
  /** APNs gateway origin. Defaults to the real production endpoint; overridable so tests never touch Apple's servers. */
  host?: string;
}

export type PushResult =
  | { ok: true; status: 200 }
  | { ok: false; status: number; reason: 'gone' | 'error'; body: string };

/** Apple rejects provider tokens older than 60 minutes and rate-limits how often a key can mint a new one. Refresh well inside that margin. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

const PRODUCTION_HOST = 'https://api.push.apple.com';

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')).toString('base64url');
}

/**
 * One APNs provider connection: caches its JWT and reuses one HTTP/2
 * session across every push it sends. Construct one instance from env
 * config and keep it — do not build a new one per push, that defeats the
 * entire point (see the file-level comment).
 */
export class ApnsClient {
  readonly #config: ApnsConfig;
  readonly #privateKey: crypto.KeyObject;
  #cachedJwt: { token: string; issuedAt: number } | undefined;
  #session: http2.ClientHttp2Session | undefined;

  constructor(config: ApnsConfig) {
    this.#config = config;
    this.#privateKey = crypto.createPrivateKey({ key: config.privateKeyPem, format: 'pem' });
  }

  /**
   * Returns the current provider-authentication JWT, minting a new one
   * only when the cached one is missing or older than {@link TOKEN_LIFETIME_MS}.
   *
   * ES256 per Apple's spec: header `{ alg: "ES256", kid }`, claims
   * `{ iss, iat }`, signed over `base64url(header).base64url(payload)`.
   *
   * The one flag that matters: `dsaEncoding: 'ieee-p1363'`. node:crypto's
   * default DSA encoding for EC signatures is DER (an ASN.1 SEQUENCE of two
   * variable-length integers) — that is what X.509/TLS wants, but JWS/JWT
   * requires the fixed-size raw `r || s` concatenation (P1363 form
   * <https://www.rfc-editor.org/rfc/rfc7518#section-3.4>). Sign with the
   * default encoding and the token is well-formed base64 that no JWT
   * library (including Apple's) will parse as a valid ES256 signature.
   */
  getJwt(): string {
    const now = Date.now();
    if (this.#cachedJwt && now - this.#cachedJwt.issuedAt < TOKEN_LIFETIME_MS) {
      return this.#cachedJwt.token;
    }

    const header = { alg: 'ES256', kid: this.#config.keyId };
    const payload = { iss: this.#config.teamId, iat: Math.floor(now / 1000) };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
      key: this.#privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    const token = `${signingInput}.${base64url(signature)}`;
    this.#cachedJwt = { token, issuedAt: now };
    return token;
  }

  /** Returns the cached session if it's still usable, otherwise opens (and caches) a fresh one. */
  #getSession(): http2.ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) {
      return this.#session;
    }
    const session = http2.connect(this.#config.host ?? PRODUCTION_HOST);
    // A session-level error or close (idle timeout, network blip, Apple
    // resetting the connection) must not wedge every push after it into a
    // dead session — drop the reference so the next getSession() call
    // reconnects instead of one-session-per-push being the only fallback.
    session.on('error', () => {
      if (this.#session === session) this.#session = undefined;
    });
    session.on('close', () => {
      if (this.#session === session) this.#session = undefined;
    });
    this.#session = session;
    return session;
  }

  /**
   * Sends the content-free wake-up push PassKit expects: body is the
   * literal two-byte JSON `{}` (BUILD.md §9.3 — "the push carries no
   * content"; the visible banner comes from a pass field's own
   * `changeMessage`), `apns-topic` is the **Pass Type ID**, not a bundle
   * ID (the single most common mistake integrating this API).
   */
  async sendPush(pushToken: string, passTypeId: string): Promise<PushResult> {
    const session = this.#getSession();
    const jwt = this.getJwt();
    const body = Buffer.from('{}', 'utf8');

    return new Promise<PushResult>((resolve) => {
      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${pushToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': passTypeId,
        'content-length': String(body.length),
      });

      let status = 0;
      let responseBody = '';
      req.setEncoding('utf8');
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      req.on('end', () => {
        if (status === 200) {
          resolve({ ok: true, status: 200 });
        } else if (status === 410) {
          // Apple's signal that the pass was removed from the device —
          // callers must delete the corresponding Device row so future
          // stamps stop trying to push to a token that will never work
          // again.
          resolve({ ok: false, status, reason: 'gone', body: responseBody });
        } else {
          resolve({ ok: false, status, reason: 'error', body: responseBody });
        }
      });
      req.on('error', (err) => {
        // The stream (and likely the whole session) is broken — drop the
        // cached session so the next push reconnects rather than reusing
        // something dead.
        if (this.#session === session) {
          this.#session = undefined;
          session.close();
        }
        resolve({ ok: false, status: 0, reason: 'error', body: err.message });
      });
      req.end(body);
    });
  }

  /** Closes the cached session, if any. Callers don't need this in steady state — only for clean shutdown/tests. */
  close(): void {
    this.#session?.close();
    this.#session = undefined;
  }
}
