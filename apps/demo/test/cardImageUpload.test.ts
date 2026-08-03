// apps/demo/test/cardImageUpload.test.ts — HTTP-level checks for the image
// designer's upload/serve path: POST /cards/:id/image and GET /img/:hash.
// Spawns the real server (apps/demo/server.ts) as a child process against
// the real local Postgres, same convention as httpIntegration.test.ts —
// this is where the multipart parser, the Content-Length precheck and the
// normalise-then-store pipeline all actually meet an HTTP request, which a
// direct import of cardImages.ts (cardImages.test.ts) cannot exercise.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
loadEnvFile(path.join(ROOT, '.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { encodePNG, decodePNG, opaqueBoundingBox, BASE_WIDTH, BASE_HEIGHT } = await import('../../../packages/image/src/index.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}
function randomPort(): number {
  return 49000 + Math.floor(Math.random() * 8000);
}

interface SpawnedServer {
  baseUrl: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  close(): Promise<void>;
}

async function spawnServer(): Promise<SpawnedServer> {
  const port = randomPort();
  const proc = spawn(process.execPath, ['apps/demo/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return { baseUrl, proc, close: () => closeProc(proc) };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await closeProc(proc);
  throw new Error('server did not become healthy in time');
}

function closeProc(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 3000);
  });
}

async function makeCard(): Promise<{ merchantId: string; card: Awaited<ReturnType<typeof prisma.card.create>> }> {
  const merchant = await prisma.merchant.create({
    data: {
      firebaseUid: `img-test-${randomHex(8)}`,
      email: `img-test-${randomHex(8)}@example.test`,
      name: 'Image Test Merchant',
    },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Image Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: true,
    },
  });
  return { merchantId: merchant.id, card };
}

async function cleanupMerchant(merchantId: string): Promise<void> {
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
}

const LOGO_PATH = path.join(ROOT, 'brand/logo.png');

let server: SpawnedServer;

before(async () => {
  server = await spawnServer();
});

after(async () => {
  await server.close();
});

test('uploading a real logo normalises it, stores one CardImage row, and GET /img/:hash serves it back with the right content type', async () => {
  const { merchantId, card } = await makeCard();
  try {
    const bytes = fs.readFileSync(LOGO_PATH);
    const body = new FormData();
    body.append('logo', new Blob([bytes], { type: 'image/png' }), 'logo.png');

    const res = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      ok: boolean; kind: string; hash: string; url: string; width: number; height: number; wideLogo: boolean;
    };
    assert.equal(json.ok, true);
    assert.equal(json.kind, 'logo');
    // brand/logo.png is a 1485x302 wordmark (~4.9:1) — the exact real-world
    // shape the mask-stretch bug this test guards against was found on.
    // Normalising keeps that aspect ratio (bounded to 512 on the wider
    // side), it does not force an exact 512x512 square.
    assert.equal(json.width, 512);
    assert.ok(Math.abs(json.width / json.height - 1485 / 302) < 0.02, `expected the ~4.9:1 aspect ratio to survive normalisation, got ${json.width}x${json.height}`);
    assert.equal(json.url, `/img/${json.hash}`);
    assert.equal(json.wideLogo, true, 'a ~4.9:1 wordmark must be flagged wide');

    const imgRes = await fetch(`${server.baseUrl}${json.url}`);
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers.get('content-type'), 'image/png');
    assert.match(imgRes.headers.get('cache-control') ?? '', /immutable/);
    const imgBytes = Buffer.from(await imgRes.arrayBuffer());
    assert.ok(imgBytes.length > 0);
    // PNG signature — proves this is genuinely re-encoded image data, not an echo of the upload.
    assert.deepEqual([...imgBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // The stored logo must keep its own rectangular shape, not be squashed
    // into a square — its opaque content's own aspect ratio should still
    // read as the source's ~4.9:1, not the 1:1 the old stretch-resize
    // (mask.ts's pre-fix circularMask) or the old letterbox-into-a-square
    // upload normalisation both would have produced.
    const storedBox = opaqueBoundingBox(decodePNG(imgBytes));
    assert.ok(storedBox, 'expected some opaque pixels in the stored logo');
    const storedRatio = storedBox!.width / storedBox!.height;
    // The logo artwork itself has a little internal transparent padding
    // (its own ink bounding box is 1466x283 in the original file, not the
    // full 1485x302 canvas), so the *ink's* ratio runs a bit above the
    // canvas's ~4.9:1 — a wider tolerance than the exact-canvas assertion
    // above, but still nowhere near the ~1:1 a stretch would have produced.
    assert.ok(Math.abs(storedRatio - 1485 / 302) < 0.4, `expected the stored logo's opaque region to stay a wide wordmark shape (~4.9:1-ish), got ${storedBox!.width}x${storedBox!.height} (${storedRatio.toFixed(2)}:1)`);

    const saved = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(saved.logoHash, json.hash);
    assert.equal(saved.logoUrl, json.url);

    const rows = await prisma.cardImage.findMany({ where: { hash: json.hash } });
    assert.equal(rows.length, 1);
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('Problem 1: GET /preview.png?...&fit=contain and &fit=cover produce genuinely different bytes through the HTTP endpoint, for a real wide image used as the icon', async () => {
  // The bug this guards against: the deployed app's /preview.png ignored
  // the fit parameter entirely, so contain and cover came back byte-
  // identical no matter what a merchant picked. A prior test only proved
  // the *library* (packages/image/src/raster/mask.ts's circularMask)
  // honoured fit — this test goes through the real HTTP server, uploading
  // a genuinely non-square image as the "my own icon" stamp source and
  // hitting the exact endpoint/query shape the designer's live preview
  // uses (stampSource=icon&icon=<hash>&fit=<contain|cover>).
  const { merchantId, card } = await makeCard();
  try {
    const bytes = fs.readFileSync(LOGO_PATH); // a real 1485x302 (~4.9:1) image — plenty non-square
    const body = new FormData();
    body.append('icon', new Blob([bytes], { type: 'image/png' }), 'icon.png');
    const res = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; kind: string; hash: string };
    assert.equal(json.ok, true);
    assert.equal(json.kind, 'icon');

    const previewQsFor = (fit: string) =>
      new URLSearchParams({
        goal: '8', filled: '3', bg: '#203757', active: '#F96400', inactive: '#8794A5',
        shape: 'circle', opacity: '1', scale: '3', stampSource: 'icon', icon: json.hash, fit,
      });
    const [containRes, coverRes] = await Promise.all([
      fetch(`${server.baseUrl}/preview.png?${previewQsFor('contain').toString()}`),
      fetch(`${server.baseUrl}/preview.png?${previewQsFor('cover').toString()}`),
    ]);
    assert.equal(containRes.status, 200);
    assert.equal(coverRes.status, 200);
    const [containBytes, coverBytes] = await Promise.all([
      containRes.arrayBuffer().then(Buffer.from),
      coverRes.arrayBuffer().then(Buffer.from),
    ]);
    const containImg = decodePNG(containBytes);
    const coverImg = decodePNG(coverBytes);
    assert.equal(containImg.width, BASE_WIDTH * 3);
    assert.equal(containImg.height, BASE_HEIGHT * 3);
    assert.equal(coverImg.width, BASE_WIDTH * 3);
    assert.notDeepEqual(containBytes, coverBytes, 'fit=contain and fit=cover must render different pixels through the real HTTP endpoint');
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('BUILD.md §8.16: the enrol page shows the merchant logo once uploaded, and shows nothing extra when there is none', async () => {
  const { merchantId, card } = await makeCard();
  try {
    const before = await fetch(`${server.baseUrl}/${card.linkCode}`);
    assert.equal(before.status, 200);
    const beforeHtml = await before.text();
    assert.doesNotMatch(beforeHtml, /class="enrol-logo"/, 'no logo uploaded yet — no <img> for it');

    const body = new FormData();
    body.append('logo', new Blob([fs.readFileSync(LOGO_PATH)], { type: 'image/png' }), 'logo.png');
    const uploadRes = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body });
    assert.equal(uploadRes.status, 200);
    const uploadJson = (await uploadRes.json()) as { url: string };

    const after = await fetch(`${server.baseUrl}/${card.linkCode}`);
    assert.equal(after.status, 200);
    const afterHtml = await after.text();
    assert.match(afterHtml, /class="enrol-logo"/);
    assert.ok(afterHtml.includes(uploadJson.url), 'the enrol page logo <img> must point at the uploaded logo');
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('GET /img/:hash 404s for a well-formed but unknown hash', async () => {
  const fakeHash = 'a'.repeat(64);
  const res = await fetch(`${server.baseUrl}/img/${fakeHash}`);
  assert.equal(res.status, 404);
});

test('an upload over 2 MB (but under the request-level cap) is rejected with 413 and a clear message', async () => {
  // Sized so the raw file part alone trips the post-parse "file.data.length
  // > MAX_UPLOAD_BYTES" check in server.ts, i.e. the whole multipart body
  // is read successfully first — the easy case, no draining/closing race.
  const { merchantId, card } = await makeCard();
  try {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1024, 7);
    const body = new FormData();
    body.append('cover', new Blob([oversized], { type: 'image/png' }), 'huge.png');

    const res = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body });
    assert.equal(res.status, 413);
    const json = (await res.json()) as { ok: boolean; error: string };
    assert.equal(json.ok, false);
    assert.match(json.error, /2 MB|byte/i);
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('an upload whose *declared* size exceeds the request-level cap gets a real 413 JSON response over fetch(), not a connection reset', async () => {
  // This is the case that actually exercises sendJsonAndClose: the request
  // body is well over MAX_UPLOAD_REQUEST_BYTES, so the Content-Length
  // precheck in handleUploadCardImage rejects before ever fully reading the
  // body. Using the platform fetch() + FormData (the same API the card
  // designer's own upload JS uses) is deliberate — a naive `req.destroy()`
  // synchronous with the response write reproduced as a bare `fetch failed`
  // / ECONNRESET here rather than a readable 413, because destroying the
  // shared socket raced the client's read of the response.
  const { merchantId, card } = await makeCard();
  try {
    const huge = Buffer.alloc(5 * 1024 * 1024, 9); // 5 MB, well past MAX_UPLOAD_REQUEST_BYTES (~2.06 MB)
    const body = new FormData();
    body.append('cover', new Blob([huge], { type: 'image/png' }), 'huge.png');

    const res = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body });
    assert.equal(res.status, 413, 'expected a real 413 response, not a thrown/rejected fetch()');
    const json = (await res.json()) as { ok: boolean; error: string };
    assert.equal(json.ok, false);
    assert.match(json.error, /large/i);

    // The card must be completely untouched by a rejected upload.
    const after = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(after.coverHash, null);
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('an upload that is not a decodable image is rejected with 400 and a clear message', async () => {
  const { merchantId, card } = await makeCard();
  try {
    const body = new FormData();
    body.append('logo', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'notes.txt');

    const res = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { ok: boolean; error: string };
    assert.equal(json.ok, false);
    assert.match(json.error, /decode/i);
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('an upload whose dimensions exceed 4000x4000 is rejected with 400 and a clear message', async () => {
  const { merchantId, card } = await makeCard();
  try {
    const rgba = new Uint8Array(4001 * 1 * 4).fill(255);
    const png = new Uint8Array(encodePNG(rgba, 4001, 1));
    const body = new FormData();
    body.append('cover', new Blob([png], { type: 'image/png' }), 'wide.png');

    const res = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { ok: boolean; error: string };
    assert.equal(json.ok, false);
    assert.match(json.error, /4000/);
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('a request with no logo/cover file field is rejected with 400', async () => {
  const { merchantId, card } = await makeCard();
  try {
    const body = new FormData();
    body.append('somethingElse', new Blob([Buffer.from('x')]), 'x.png');
    const res = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body });
    assert.equal(res.status, 400);
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('uploading to an unknown card id is rejected with 404', async () => {
  const body = new FormData();
  body.append('logo', new Blob([fs.readFileSync(LOGO_PATH)], { type: 'image/png' }), 'logo.png');
  const res = await fetch(`${server.baseUrl}/cards/nonexistent-card-id/image`, { method: 'POST', body });
  assert.equal(res.status, 404);
});

test('image edits on a card that already has passes succeed (200/303), while an economic edit on the same card still 409s', async () => {
  const { merchantId, card } = await makeCard();
  try {
    await prisma.pass.create({
      data: {
        serial: `IMGSER${randomHex(6)}`.toUpperCase(),
        shortCode: `P${randomHex(4)}`.toUpperCase(),
        cardId: card.id,
        merchantId,
        authToken: randomHex(12),
      },
    });

    // Uploading a logo — purely cosmetic — succeeds on a locked card.
    const uploadBody = new FormData();
    uploadBody.append('logo', new Blob([fs.readFileSync(LOGO_PATH)], { type: 'image/png' }), 'logo.png');
    const uploadRes = await fetch(`${server.baseUrl}/cards/${card.id}/image`, { method: 'POST', body: uploadBody });
    assert.equal(uploadRes.status, 200);
    const uploadJson = (await uploadRes.json()) as { hash: string };

    // Saving the edit form with only cosmetic changes (colours, shape,
    // labels, and the logo hash just uploaded) succeeds — a 303 redirect,
    // not a 409 — even though this card is locked.
    const cosmeticForm = new URLSearchParams({
      name: card.name,
      bgColor: '#111111',
      bgOpacity: '80',
      stampActive: '#00FF00',
      stampInactive: '#8794A5',
      stampShape: 'square',
      labelStamps: 'Punches',
      labelRewards: 'Prize',
      logoHash: uploadJson.hash,
      coverHash: '',
      // Economic fields intentionally omitted, as the rendered (locked) form would.
    });
    const cosmeticRes = await fetch(`${server.baseUrl}/cards/${card.id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: cosmeticForm.toString(),
      redirect: 'manual',
    });
    assert.equal(cosmeticRes.status, 303, 'a cosmetic-only edit on a locked card should succeed');

    const afterCosmetic = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(afterCosmetic.logoHash, uploadJson.hash);
    assert.equal(afterCosmetic.stampShape, 'square');
    assert.equal(afterCosmetic.stampsGoal, 8, 'stampsGoal must be untouched by a cosmetic-only edit');

    // The same form, but now also attempting to change stampsGoal — must 409.
    const economicForm = new URLSearchParams({
      name: card.name,
      bgColor: '#111111',
      bgOpacity: '80',
      stampActive: '#00FF00',
      stampInactive: '#8794A5',
      stampShape: 'square',
      labelStamps: 'Punches',
      labelRewards: 'Prize',
      logoHash: uploadJson.hash,
      coverHash: '',
      stampsGoal: '20',
    });
    const economicRes = await fetch(`${server.baseUrl}/cards/${card.id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: economicForm.toString(),
      redirect: 'manual',
    });
    assert.equal(economicRes.status, 409, 'an economic edit on a locked card must still be rejected');

    const afterEconomic = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(afterEconomic.stampsGoal, 8, 'the rejected economic edit must leave stampsGoal untouched');
  } finally {
    await prisma.stampEvent.deleteMany({ where: { cardId: card.id } });
    await cleanupMerchant(merchantId);
  }
});
