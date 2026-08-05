// apps/demo/views/stampScreen.ts — the counter stamp screen (BUILD.md §8.15).
//
// Extracted from server.ts on 5 August 2026. This is the one merchant page
// that does not go through layout(): it needs camera CSS no other page wants,
// and a staff PIN session gets a deliberately shorter header.
//
// That combination made it the page most likely to drift from the rest — and
// it had. When it carried its own copy of the chrome, that copy's :root never
// declared --sunk, so the top bar rendered flat against the canvas, and it
// never declared .btn at all, so Sign out came out as a raw browser button.
// It imports CHROME_CSS now for exactly that reason: a shell may be its own,
// but its chrome may not be a copy.

import { t, type Lang } from '../../../packages/i18n/src/index.ts';
import { escapeHtml } from './html.ts';
import { CHROME_CSS, navBar, tabBar } from './chrome.ts';

// Route: GET /stamp — the merchant stamp screen (BUILD.md §8.15). Our
// replacement for the competitor's scanner app: a browser page, opened on
// whatever phone or tablet is at the counter, that scans the QR *inside a
// customer's wallet pass* (the "Card QR" in BUILD.md §7.3's table — it
// encodes the pass `serial`, never the printed, static "Join QR" that the
// card detail page shows). Decodes real camera frames with jsQR (vendored
// same-origin at /jsQR.js — see scripts/vendor-jsqr.ts), with
// `BarcodeDetector` as an opt-in fast path only where the browser actually
// has it (§8.15's own warning: it's absent on iOS/iPadOS, every Firefox,
// and Chrome on Windows/Linux — never rely on it alone). Manual entry
// (serial or shortCode) works fully independently of the camera path, and
// both converge on the same POST /api/stamp write below. Dark brand tokens
// per BUILD.md §3 (2026-08-03 revision):
// canvas #0F172A, paper #1C2A42, accent #F28C38, IBM Plex Sans Arabic typeface.
// ---------------------------------------------------------------------------
/** Who is viewing the stamp screen — mirrors StampAuth above, minus the full Merchant/Staff rows (renderStampScreen only ever needs a name to display). */
export type StampScreenViewer = { kind: 'merchant' } | { kind: 'staff'; staffName: string };

/**
 * The header a *staff* session sees on the stamp screen — deliberately not
 * navBar(): every link navBar renders (Cards, Customers, Reports, Settings)
 * 302s a staff session straight to /signin (requireMerchant() never
 * recognises the `lnx-staff` cookie), so showing them here would just be a
 * row of dead ends. Brand plus a sign-out button is everything a staff
 * session can actually do besides stamp.
 */
export function staffHeader(lang: Lang): string {
  return `<header class="top">
  <a class="brand" href="/stamp">LoyaNexa</a>
  <form method="POST" action="/stamp/signout" style="margin-inline-start:auto;">
    <button type="submit" class="btn secondary small">${escapeHtml(t(lang, 'stampScreenStaffSignOut'))}</button>
  </form>
</header>`;
}

export function renderStampScreen(lang: Lang = 'en', viewer: StampScreenViewer = { kind: 'merchant' }): string {
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t(lang, 'stampScreenTitle'))} · LoyaNexa</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&display=swap">
<style>
${CHROME_CSS}
  /* Stamp-screen-only chrome overrides: this page is a single narrow
     column at a counter, not a dashboard page, so its main is tighter
     than CHROME_CSS's. The bottom-tab-bar clearance still applies. */
  main { max-width: 480px; margin: 0 auto; padding: 20px 20px 56px; }
  @media (max-width: 720px) {
    main { padding-bottom: calc(76px + env(safe-area-inset-bottom, 0px)); }
  }
  h1 { font-size: 22px; margin: 4px 0 6px; }
  p.sub { color: var(--ink-3); font-size: 14px; margin: 0 0 18px; line-height: 1.5; }
  .notice {
    background: rgba(242,140,56,.10); border: 1px solid rgba(242,140,56,.28); color: var(--accent);
    border-radius: 14px; padding: 12px 16px; margin-bottom: 18px; font-size: 13px; line-height: 1.5;
  }
  .panel { background: var(--paper); border: 1px solid var(--line); border-radius: 18px; padding: 20px; margin-bottom: 18px; }
  h2 { font-size: 13px; margin: 0 0 12px; color: var(--ink-2); text-transform: uppercase; letter-spacing: .06em; }
  .camera-wrap { position: relative; border-radius: 14px; overflow: hidden; background: #000; aspect-ratio: 4 / 3; }
  video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .camera-status { margin-top: 10px; font-size: 13px; color: var(--ink-3); text-align: center; min-height: 18px; }
  form.manual .field { margin-bottom: 14px; }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--ink-2); }
  input[type="text"] {
    width: 100%; border: 1px solid var(--line); border-radius: 12px; padding: 16px;
    font-size: 18px; background: var(--raise); color: var(--ink); font-family: inherit;
    text-transform: uppercase;
  }
  input[type="text"]::placeholder { color: var(--ink-3); text-transform: none; }
  button.stamp-btn {
    display: block; width: 100%; border: none; border-radius: 100px; padding: 18px 20px;
    font-size: 17px; font-weight: 700; color: var(--on-accent); background: var(--accent);
    cursor: pointer; min-height: 56px; font-family: inherit;
  }
  button.stamp-btn:active { background: var(--accent-hover); }
  button.stamp-btn:disabled { opacity: .6; cursor: default; }
  #result {
    display: none; border-radius: 14px; padding: 18px; margin-bottom: 18px;
    font-size: 18px; font-weight: 700; text-align: center; line-height: 1.4;
  }
  #result.success { display: block; background: rgba(34,197,94,.14); border: 1px solid rgba(34,197,94,.4); color: var(--green); }
  #result.error { display: block; background: rgba(239,68,68,.14); border: 1px solid rgba(247,178,103,.4); color: var(--amber); }
</style>
</head>
<body>
${viewer.kind === 'staff' ? staffHeader(lang) : navBar('stamp', lang)}
<main>
  <h1>${escapeHtml(t(lang, 'stampScreenTitle'))}</h1>
  <p class="sub">${escapeHtml(t(lang, 'stampScreenSub'))}</p>
  <div class="notice">${escapeHtml(
    viewer.kind === 'staff'
      ? t(lang, 'stampScreenStaffBadge', { name: viewer.staffName })
      : t(lang, 'stampScreenNoticeMerchant')
  )}</div>

  <div id="result" role="status" aria-live="polite"></div>

  <div class="panel">
    <h2>${escapeHtml(t(lang, 'stampScreenCameraHeading'))}</h2>
    <div class="camera-wrap">
      <video id="video" playsinline muted></video>
    </div>
    <p class="camera-status" id="cameraStatus">${escapeHtml(t(lang, 'stampScreenCameraStarting'))}</p>
  </div>

  <div class="panel">
    <h2>${escapeHtml(t(lang, 'stampScreenManualHeading'))}</h2>
    <form class="manual" id="manualForm">
      <div class="field">
        <label for="manualCode">${escapeHtml(t(lang, 'stampScreenManualLabel'))}</label>
        <input type="text" id="manualCode" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${escapeHtml(t(lang, 'stampScreenManualPlaceholder'))}" required>
      </div>
      <button class="stamp-btn" type="submit" id="manualSubmit">${escapeHtml(t(lang, 'stampScreenSubmitButton'))}</button>
    </form>
  </div>
</main>
${
  // A staff session gets no tab bar, for the same reason staffHeader() exists:
  // every destination on it (Cards, Customers, Notifications, More) 302s a
  // staff cookie to /signin, so it would be a row of dead ends under their
  // thumb. A merchant viewing this page gets the same bar as everywhere else.
  viewer.kind === 'staff' ? '' : tabBar('stamp', lang)
}
<canvas id="canvas" style="display:none;"></canvas>
<script src="/jsQR.js"></script>
<script>
(function () {
  'use strict';

  // Translated server-side (this whole page is rendered once per request
  // via resolveLang(req)) rather than in the client, same as every other
  // string on this screen — the two messages the fetch() below can show
  // when the server didn't hand back its own translated message.
  var MSG_UNKNOWN_ERROR = ${JSON.stringify(t(lang, 'serverError'))};
  var MSG_NETWORK_ERROR = ${JSON.stringify(t(lang, 'stampScreenNetworkError'))};

  var resultEl = document.getElementById('result');
  var video = document.getElementById('video');
  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var cameraStatus = document.getElementById('cameraStatus');
  var manualForm = document.getElementById('manualForm');
  var manualCode = document.getElementById('manualCode');
  var manualSubmit = document.getElementById('manualSubmit');

  // -----------------------------------------------------------------------
  // QR decode interface — BUILD.md §8.15. jsQR (vendored same-origin at
  // /jsQR.js — see scripts/vendor-jsqr.ts, loaded via the <script> tag just
  // above this one) is the decoder that must always work: it is pure JS,
  // runs everywhere, and is what BUILD.md names for exactly this screen.
  // BarcodeDetector is used ONLY as an opt-in fast path when the browser
  // actually has a working one — never the other way around, and never
  // relied on alone, because it is absent on iOS/iPadOS Safari, every
  // Firefox, and Chrome on Windows/Linux (the "café stamping on an iPad"
  // case this screen exists to serve). The choice between the two is made
  // once, at startup, from feature detection — not re-decided per frame —
  // so a capable browser never pays for both a BarcodeDetector call and a
  // canvas grab + jsQR pass on the same frame.
  // -----------------------------------------------------------------------
  var hasBarcodeDetector = false;
  var barcodeDetector = null;
  if (typeof window.BarcodeDetector === 'function') {
    try {
      barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      hasBarcodeDetector = true;
    } catch (e) {
      hasBarcodeDetector = false;
      barcodeDetector = null;
    }
  }

  function decodeWithJsQR(imageData) {
    if (typeof window.jsQR !== 'function') return null; // /jsQR.js failed to load — camera scanning degrades to manual entry
    var result = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
    return result && result.data ? result.data : null;
  }

  var busy = false;
  var lastScanAt = 0;
  var scanBusy = false; // guards overlapping BarcodeDetector.detect() calls, which are async
  var currentStream = null;
  var scanRAF = null;

  // Debounce: a QR code held in front of the lens would otherwise decode
  // and fire submitCode() on every ~150ms tick — dozens of times a second
  // relative to a human moving the pass away. The server's 24h guard would
  // reject every repeat anyway, but hammering /api/stamp is still wrong.
  var SCAN_COOLDOWN_MS = 4000;
  var lastScannedCode = null;
  var lastScannedAt = 0;

  function showResult(ok, message) {
    resultEl.className = ok ? 'success' : 'error';
    resultEl.textContent = (ok ? '\\u2713 ' : '\\u26A0 ') + message;
  }

  function setBusy(next) {
    busy = next;
    manualSubmit.disabled = next;
  }

  function submitCode(code) {
    if (busy) return;
    setBusy(true);
    fetch('/api/stamp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        var message = result.data && result.data.message ? result.data.message : MSG_UNKNOWN_ERROR;
        showResult(result.ok, message);
      })
      .catch(function () {
        showResult(false, MSG_NETWORK_ERROR);
      })
      .then(function () {
        setBusy(false);
      });
  }

  // Camera decodes reach the exact same submitCode() / POST /api/stamp path
  // manual entry uses — one write path, two ways to reach it — but only
  // camera decodes pass through the repeat-code cooldown above; a member of
  // staff retyping the same code by hand is a deliberate action, not a
  // held-up QR still in frame.
  function handleScannedCode(code, ts) {
    if (!code) return;
    if (code === lastScannedCode && ts - lastScannedAt < SCAN_COOLDOWN_MS) return;
    lastScannedCode = code;
    lastScannedAt = ts;
    submitCode(code);
  }

  manualForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = manualCode.value.trim();
    if (!value) return;
    submitCode(value);
    manualForm.reset();
    manualCode.focus();
  });

  function scanLoop(ts) {
    scanRAF = requestAnimationFrame(scanLoop);
    if (scanBusy) return;
    if (video.readyState < video.HAVE_ENOUGH_DATA) return;
    if (ts - lastScanAt <= 150) return;
    lastScanAt = ts;
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;

    if (hasBarcodeDetector) {
      scanBusy = true;
      barcodeDetector.detect(video)
        .then(function (codes) {
          var value = codes && codes.length && codes[0] && codes[0].rawValue ? codes[0].rawValue : null;
          if (value) handleScannedCode(value, ts);
        })
        .catch(function () { /* transient decode failure — try again next frame */ })
        .then(function () { scanBusy = false; });
      return;
    }

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    var imageData = ctx.getImageData(0, 0, w, h);
    var code = decodeWithJsQR(imageData);
    if (code) handleScannedCode(code, ts);
  }

  // Stops the live camera track (and the scan loop driving it) — called
  // when the tab is hidden/backgrounded and on pagehide. A camera left
  // running on a counter tablet drains the battery and is a privacy risk;
  // there is nothing to see once the page is not the active tab.
  function stopCamera() {
    if (scanRAF !== null) {
      cancelAnimationFrame(scanRAF);
      scanRAF = null;
    }
    if (currentStream) {
      currentStream.getTracks().forEach(function (track) { track.stop(); });
      currentStream = null;
    }
  }

  function startCamera() {
    if (currentStream) return; // already running
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      cameraStatus.textContent = 'Camera not supported on this browser — use manual entry below.';
      return;
    }
    cameraStatus.textContent = 'Starting camera…';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (stream) {
        currentStream = stream;
        video.srcObject = stream;
        return video.play();
      })
      .then(function () {
        cameraStatus.textContent = 'Camera live — point it at the pass QR code.';
        lastScanAt = 0;
        scanRAF = requestAnimationFrame(scanLoop);
      })
      .catch(function () {
        cameraStatus.textContent = 'Camera unavailable — use manual entry below.';
        currentStream = null;
      });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopCamera();
    } else {
      startCamera();
    }
  });
  window.addEventListener('pagehide', stopCamera);

  startCamera();
})();
</script>
</body>
</html>`;
}
