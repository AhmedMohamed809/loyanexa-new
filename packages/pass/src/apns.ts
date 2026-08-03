// packages/pass/src/apns.ts
//
// The APNs half of live pass updates (BUILD.md §9.3 step 2, §18 items 3/6).
// A stamp landing in Postgres is invisible to the customer until something
// wakes their phone up — that's this file's only job: authenticate to
// Apple and POST an empty `{}` push to every registered device, over a
// long-lived HTTP/2 connection.
//
// No new npm dependencies: node:crypto signs the ES256 JWT (token mode),
// node:http2 is the wire protocol APNs requires (HTTP/1.1 is not accepted
// on this endpoint) for both modes.
//
// Two auth modes, selected by the caller via `ApnsConfig.auth.mode`
// (server.ts wires this to `APNS_AUTH`, default `'certificate'` — see
// docs/BUILD.md §2's 2026-08-03 note for why):
//
//   'certificate' — mTLS. The Pass Type ID certificate (+ WWDR intermediate)
//   is presented as the TLS *client* certificate on the HTTP/2 connection
//   itself; there is no Authorization header and no JWT. This is Apple's
//   original, pre-token APNs provider-auth method, and the one this
//   deployment's APNs Auth Key cannot use instead: that key is provisioned
//   sandbox-only in the Apple Developer portal, so every token-authenticated
//   push to production 403s with BadEnvironmentKeyInToken. The certificate
//   we hold has no such restriction — it authenticates against both of
//   Apple's gateways.
//
//   'token' — the JWT-over-`.p8` method. Kept, and still the better
//   long-term choice once the key is (re)provisioned for Production in the
//   portal: a token never expires the way a certificate does (yearly), and
//   rotating a compromised key is cheaper than re-issuing a certificate.
//   Until that portal change happens, this mode is provably unusable against
//   production — see isBadEnvironmentKeyError's doc comment.
//
// Two traps this file exists to avoid (BUILD.md §18 item 3, and the APNs
// provider-auth spec) apply to both modes identically:
//   1. Rebuilding the HTTP/2 session per push. TLS handshake plus APNs'
//      own connection-establishment cost makes that slow, and hammering
//      Apple with fresh connections risks a rate limit. One session is
//      opened lazily and reused for every push; it's only rebuilt after an
//      error/close tears it down (or never successfully opened at all —
//      see #getSession's doc comment for why a *failed* connect attempt
//      must not wedge every push after it the same way a torn-down session
//      does).
//   2. Regenerating the JWT per push (token mode only). Apple rate-limits
//      how often a given key can mint a fresh provider token, and rejects
//      tokens older than an hour. The token is cached and only rebuilt
//      after ~50 minutes.

import crypto from 'node:crypto';
import http2 from 'node:http2';

/**
 * Which of Apple's two APNs gateways to push to. In token mode, an APNs
 * Auth Key (APNS_KEY_ID) is provisioned in the Apple Developer portal for
 * one or the other — see {@link resolveApnsHost}'s doc comment for how a
 * mismatch between this and the key's actual provisioning shows up. In
 * certificate mode the same two gateways exist, but the Pass Type ID
 * certificate this deployment holds authenticates against both.
 */
export type ApnsEnvironment = 'production' | 'sandbox';

/** Which of the two ways this client authenticates to Apple — see the file-level comment for the tradeoffs. */
export type ApnsAuthMode = 'certificate' | 'token';

export interface ApnsCertificateAuth {
  mode: 'certificate';
  /**
   * PEM certificate chain presented as the TLS client certificate: the
   * Pass Type ID (leaf) certificate followed by the WWDR intermediate,
   * concatenated — exactly the two files `resolveAppleCredentials()`
   * already materialises for *signing* passes (`signerCertPath` +
   * `wwdrPath`), reused here for push. Node's `tls.connect` accepts a
   * multi-certificate chain as one PEM string, ordered leaf-then-root, per
   * its own docs; Apple's gateway needs the intermediate present to build
   * trust up to its own root, the same reason `buildPass.ts`'s `openssl
   * smime -certfile` call includes it when signing.
   */
  certChainPem: string;
  /** PEM private key matching `certChainPem`'s leaf certificate. */
  keyPem: string;
}

export interface ApnsTokenAuth {
  mode: 'token';
  /** The 10-character APNs Auth Key ID (APNS_KEY_ID) — becomes the JWT's `kid`. */
  keyId: string;
  /** The Apple Developer Team ID (APPLE_TEAM_ID) — becomes the JWT's `iss`. */
  teamId: string;
  /** PEM contents of the `.p8` signing key (PKCS8, EC P-256). Never a file path — see credentials.ts's resolveApnsKeyPem(). */
  privateKeyPem: string;
}

export type ApnsAuth = ApnsCertificateAuth | ApnsTokenAuth;

export interface ApnsConfig {
  auth: ApnsAuth;
  /**
   * Which APNs gateway to push to (APNS_ENV). Defaults to `'production'`.
   * Ignored when `host` is also set — `host` exists purely so tests can
   * point the client at a local stand-in instead of either real gateway.
   */
  environment?: ApnsEnvironment;
  /** Explicit gateway override — takes priority over `environment`. Exists so tests never touch Apple's servers. */
  host?: string;
}

export type PushResult =
  | { ok: true; status: 200 }
  | { ok: false; status: number; reason: 'gone' | 'error'; body: string };

/** Apple rejects provider tokens older than 60 minutes and rate-limits how often a key can mint a new one. Refresh well inside that margin. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

/**
 * Parses the `APNS_ENV` env var into an {@link ApnsEnvironment}, defaulting
 * to `'production'` for anything other than the exact string `'sandbox'`
 * (unset, empty, misspelled, or explicitly `'production'` all land there).
 * A wrong-but-plausible value failing safe to production — the environment
 * this app is meant to ship against — beats it silently switching to
 * sandbox and pushes quietly going nowhere real.
 */
export function parseApnsEnvironment(raw: string | undefined): ApnsEnvironment {
  return raw === 'sandbox' ? 'sandbox' : 'production';
}

/**
 * Parses the `APNS_AUTH` env var into an {@link ApnsAuthMode}, defaulting to
 * `'certificate'` for anything other than the exact string `'token'`. This
 * default matches the working path for this deployment (see the file-level
 * comment): the provisioned APNs Auth Key is sandbox-only, so token mode
 * 403s against production until that's fixed in the Apple Developer portal,
 * while the Pass Type ID certificate already works against both gateways.
 * `'token'` is opt-in, not opt-out, so switching back once the key is fixed
 * is a deliberate one-word change, not a default nobody chose.
 */
export function parseApnsAuthMode(raw: string | undefined): ApnsAuthMode {
  return raw === 'token' ? 'token' : 'certificate';
}

/** Maps an {@link ApnsEnvironment} to its gateway origin. Pure — no I/O, so it's trivially unit-testable without touching Apple. */
export function resolveApnsHost(environment: ApnsEnvironment): string {
  return environment === 'sandbox' ? SANDBOX_HOST : PRODUCTION_HOST;
}

/**
 * True for the specific Apple error this file exists to make loud instead
 * of cryptic: a `403` whose body names `BadEnvironmentKeyInToken` means the
 * APNs Auth Key (`apns-topic`'s key, identified by the JWT's `kid`) is
 * provisioned in the Apple Developer portal for the *other* environment
 * than the one this request targeted — e.g. a sandbox-only key pushing to
 * `api.push.apple.com`. This is a portal setting, not a request/JWT bug:
 * changing `APNS_ENV` only helps if the key really is provisioned for the
 * other side; otherwise both hosts 403 identically. Only reachable in token
 * mode — certificate mode has no JWT/key for Apple to reject this way.
 */
export function isBadEnvironmentKeyError(status: number, body: string): boolean {
  return status === 403 && body.includes('BadEnvironmentKeyInToken');
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')).toString('base64url');
}

/**
 * One APNs provider connection: reuses one HTTP/2 session across every push
 * it sends, and (token mode only) caches its JWT. Construct one instance
 * from env config and keep it — do not build a new one per push, that
 * defeats the entire point (see the file-level comment).
 */
export class ApnsClient {
  readonly #config: ApnsConfig;
  readonly #privateKey: crypto.KeyObject | undefined; // token mode only
  /** Resolved once at construction: `config.host` if set, otherwise whatever `config.environment` (default production) maps to. */
  readonly #host: string;
  #cachedJwt: { token: string; issuedAt: number } | undefined;
  #session: http2.ClientHttp2Session | undefined;

  constructor(config: ApnsConfig) {
    this.#config = config;
    this.#privateKey =
      config.auth.mode === 'token'
        ? crypto.createPrivateKey({ key: config.auth.privateKeyPem, format: 'pem' })
        : undefined;
    this.#host = config.host ?? resolveApnsHost(config.environment ?? 'production');
  }

  /** The gateway origin this client pushes to — exposed for logging and tests, never re-derived from `config` after construction. */
  get host(): string {
    return this.#host;
  }

  /** Which auth mode this client uses — exposed so callers can name it in failure logs without threading the env var through separately. */
  get authMode(): ApnsAuthMode {
    return this.#config.auth.mode;
  }

  /**
   * Returns the current provider-authentication JWT, minting a new one
   * only when the cached one is missing or older than {@link TOKEN_LIFETIME_MS}.
   * Token mode only — throws if called in certificate mode, which has no JWT.
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
    if (this.#config.auth.mode !== 'token' || !this.#privateKey) {
      throw new Error('getJwt() is only valid for an ApnsClient constructed with auth.mode "token"');
    }
    const auth = this.#config.auth;
    const now = Date.now();
    if (this.#cachedJwt && now - this.#cachedJwt.issuedAt < TOKEN_LIFETIME_MS) {
      return this.#cachedJwt.token;
    }

    const header = { alg: 'ES256', kid: auth.keyId };
    const payload = { iss: auth.teamId, iat: Math.floor(now / 1000) };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
      key: this.#privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    const token = `${signingInput}.${base64url(signature)}`;
    this.#cachedJwt = { token, issuedAt: now };
    return token;
  }

  /**
   * Returns the cached session if it's still usable, otherwise opens (and
   * caches) a fresh one. Certificate mode passes the TLS client cert/key as
   * `http2.connect`'s `SecureClientSessionOptions`; token mode passes none
   * (auth travels per-request as a bearer JWT instead).
   *
   * Critically, the reference is cached *synchronously*, before the
   * `connect`/TLS handshake finishes — not after an `on('connect')` fires.
   * `http2.connect()` returns a session object immediately and queues
   * `session.request()` calls made before the handshake completes; if this
   * method waited for a connect event before caching, every push racing the
   * first handshake would each call `http2.connect()` again, opening
   * several redundant connections instead of reusing the one already in
   * flight (exactly the per-push-reconnect cost the file-level comment
   * warns about, just moved earlier). If the handshake itself fails, the
   * `error`/`close` listeners below still fire and drop the reference, so
   * the next `sendPush()` reconnects rather than reusing (or being stuck
   * behind) a session that never came up — this matters most right after a
   * Fly machine cold-starts, when the first connect attempt is the one most
   * likely to be interrupted.
   */
  #getSession(): http2.ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) {
      return this.#session;
    }
    const auth = this.#config.auth;
    const connectOptions: http2.SecureClientSessionOptions =
      auth.mode === 'certificate' ? { cert: auth.certChainPem, key: auth.keyPem } : {};
    const session = http2.connect(this.#host, connectOptions);
    // A session-level error or close (idle timeout, network blip, Apple
    // resetting the connection, or the initial handshake itself failing)
    // must not wedge every push after it into a dead/never-connected
    // session — drop the reference so the next getSession() call
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
   * ID (the single most common mistake integrating this API) — sent in
   * both auth modes; certificate mode's TLS client cert establishes *who*
   * is pushing, `apns-topic` still tells Apple *which* pass type this
   * particular push is for.
   *
   * `apns-push-type: background` + `apns-priority: 10` ask iOS to act on
   * this immediately rather than batching it for a convenient moment
   * (Apple's default for background pushes is opportunistic delivery) —
   * this is what the 1-2 second target in BUILD.md §9.3 actually depends
   * on at the network layer; the rest of the budget is the device's own
   * follow-up GET + rebuild.
   */
  async sendPush(pushToken: string, passTypeId: string): Promise<PushResult> {
    const session = this.#getSession();
    const body = Buffer.from('{}', 'utf8');

    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      'apns-topic': passTypeId,
      'apns-push-type': 'background',
      'apns-priority': '10',
      'content-length': String(body.length),
    };
    if (this.#config.auth.mode === 'token') {
      headers.authorization = `bearer ${this.getJwt()}`;
    }

    return new Promise<PushResult>((resolve) => {
      const req = session.request(headers);

      let status = 0;
      let responseBody = '';
      req.setEncoding('utf8');
      req.on('response', (responseHeaders) => {
        status = Number(responseHeaders[':status'] ?? 0);
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
