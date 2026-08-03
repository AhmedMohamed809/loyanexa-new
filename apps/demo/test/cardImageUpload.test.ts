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
const { encodePNG } = await import('../../../packages/image/src/index.ts');

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
    const json = (await res.json()) as { ok: boolean; kind: string; hash: string; url: string; width: number; height: number };
    assert.equal(json.ok, true);
    assert.equal(json.kind, 'logo');
    assert.equal(json.width, 512);
    assert.equal(json.height, 512);
    assert.equal(json.url, `/img/${json.hash}`);

    const imgRes = await fetch(`${server.baseUrl}${json.url}`);
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers.get('content-type'), 'image/png');
    assert.match(imgRes.headers.get('cache-control') ?? '', /immutable/);
    const imgBytes = Buffer.from(await imgRes.arrayBuffer());
    assert.ok(imgBytes.length > 0);
    // PNG signature — proves this is genuinely re-encoded image data, not an echo of the upload.
    assert.deepEqual([...imgBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const saved = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(saved.logoStampHash, json.hash);
    assert.equal(saved.logoIconUrl, json.url);

    const rows = await prisma.cardImage.findMany({ where: { hash: json.hash } });
    assert.equal(rows.length, 1);
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
    assert.equal(afterCosmetic.logoStampHash, uploadJson.hash);
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
