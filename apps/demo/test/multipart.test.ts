// apps/demo/test/multipart.test.ts — pure unit tests for the hand-rolled
// multipart/form-data parser (apps/demo/multipart.ts). No HTTP, no
// database: end-to-end upload behaviour (size caps read off a real
// request, the full POST /cards/:id/image route) lives in
// cardImageUpload.test.ts instead, which spawns the real server — this
// file is only about the byte-level parsing being correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBoundary, parseMultipartBuffer, httpError, isHttpError } from '../multipart.ts';

test('extractBoundary reads a bare boundary parameter', () => {
  assert.equal(extractBoundary('multipart/form-data; boundary=abc123'), 'abc123');
});

test('extractBoundary reads a quoted boundary parameter', () => {
  assert.equal(extractBoundary('multipart/form-data; boundary="abc 123"'), 'abc 123');
});

test('extractBoundary returns undefined for a non-multipart content type', () => {
  assert.equal(extractBoundary('application/json'), undefined);
  assert.equal(extractBoundary(undefined), undefined);
});

function buildMultipartBody(boundary: string, parts: Array<{ headers: string[]; body: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(part.headers.join('\r\n') + '\r\n\r\n'));
    chunks.push(part.body);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('parses one plain field and one file part', () => {
  const boundary = 'BOUND123';
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const body = buildMultipartBody(boundary, [
    { headers: ['Content-Disposition: form-data; name="kind"'], body: Buffer.from('logo') },
    {
      headers: [
        'Content-Disposition: form-data; name="logo"; filename="pic.png"',
        'Content-Type: image/png',
      ],
      body: fileBytes,
    },
  ]);

  const parsed = parseMultipartBuffer(body, boundary);
  assert.equal(parsed.fields.kind, 'logo');
  assert.equal(parsed.files.length, 1);
  const file = parsed.files[0]!;
  assert.equal(file.name, 'logo');
  assert.equal(file.filename, 'pic.png');
  assert.equal(file.contentType, 'image/png');
  assert.deepEqual([...file.data], [...fileBytes]);
});

test('preserves exact binary bytes, including bytes that resemble text markers', () => {
  const boundary = 'BOUND456';
  // Bytes deliberately include \r\n and a run that looks like a header
  // separator, to prove the parser is slicing by boundary position, not by
  // scanning for these sequences inside the body.
  const fileBytes = Buffer.from([0, 13, 10, 13, 10, 255, 254, 253, 1, 2, 3]);
  const body = buildMultipartBody(boundary, [
    {
      headers: ['Content-Disposition: form-data; name="cover"; filename="a.png"', 'Content-Type: image/png'],
      body: fileBytes,
    },
  ]);
  const parsed = parseMultipartBuffer(body, boundary);
  assert.deepEqual([...parsed.files[0]!.data], [...fileBytes]);
});

test('multiple parts are all recovered in order', () => {
  const boundary = 'B';
  const body = buildMultipartBody(boundary, [
    { headers: ['Content-Disposition: form-data; name="a"'], body: Buffer.from('1') },
    { headers: ['Content-Disposition: form-data; name="b"'], body: Buffer.from('2') },
    {
      headers: ['Content-Disposition: form-data; name="f"; filename="x.png"', 'Content-Type: image/png'],
      body: Buffer.from('bytes'),
    },
  ]);
  const parsed = parseMultipartBuffer(body, boundary);
  assert.equal(parsed.fields.a, '1');
  assert.equal(parsed.fields.b, '2');
  assert.equal(parsed.files.length, 1);
});

test('throws a 400 HttpError when the opening boundary is missing', () => {
  try {
    parseMultipartBuffer(Buffer.from('not multipart at all'), 'BOUND');
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(isHttpError(err));
    assert.equal((err as ReturnType<typeof httpError>).statusCode, 400);
  }
});

test('httpError/isHttpError round-trip', () => {
  const err = httpError(413, 'too big');
  assert.equal(isHttpError(err), true);
  assert.equal(err.statusCode, 413);
  assert.equal(isHttpError(new Error('plain')), false);
});
