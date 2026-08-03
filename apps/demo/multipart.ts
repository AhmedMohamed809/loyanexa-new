// apps/demo/multipart.ts — a small, dependency-free multipart/form-data
// parser. This app has exactly one upload endpoint (POST /cards/:id/image)
// and one field shape (a single named file part), so a general RFC 7578
// parser isn't needed — but the wire format itself still has to be handled
// correctly: a boundary that appears inside binary image bytes must not be
// mistaken for a real delimiter unless it's actually preceded by CRLF and
// followed by CRLF/`--`, so this walks the buffer with `Buffer.indexOf`
// rather than treating it as text.
//
// No new dependency: `multer`/`busboy` are exactly what BUILD.md's "no new
// npm dependencies" constraint rules out for this slice, and the format is
// simple enough for one file (RFC 7578 §4).

import type http from 'node:http';

export type HttpError = Error & { statusCode: number };

export function httpError(statusCode: number, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode });
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof Error && typeof (e as { statusCode?: unknown }).statusCode === 'number';
}

export interface MultipartFile {
  /** The `name=` in this part's Content-Disposition — the form field name. */
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface ParsedMultipart {
  files: MultipartFile[];
  fields: Record<string, string>;
}

/** Extracts the `boundary=` parameter from a `multipart/form-data; boundary=...` Content-Type header. */
export function extractBoundary(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = /boundary=(?:"([^"]*)"|([^;]+))/i.exec(contentType);
  if (!match) return undefined;
  return (match[1] ?? match[2])?.trim();
}

/**
 * Reads `req`'s body into a single Buffer, rejecting once more than
 * `maxBytes` has arrived — the request is destroyed immediately rather than
 * left to keep streaming into memory (this is a public, unauthenticated
 * endpoint; an unbounded body read is the denial-of-service surface BUILD.md
 * §18 warns about generally and this upload path specifically invites).
 */
export function readBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(httpError(413, `request body too large (over ${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const CRLF = Buffer.from('\r\n');
const HEADER_SEP = Buffer.from('\r\n\r\n');

/** Parses an already-fully-read multipart body against `boundary` (without the leading `--`). */
export function parseMultipartBuffer(buf: Buffer, boundary: string): ParsedMultipart {
  const delimiter = Buffer.from(`--${boundary}`);
  const rawParts: Buffer[] = [];

  let cursor = buf.indexOf(delimiter);
  if (cursor === -1) throw httpError(400, 'malformed multipart body: opening boundary not found');
  cursor += delimiter.length;

  while (true) {
    // The closing boundary is `--boundary--`; a part-separating boundary is
    // `--boundary\r\n`. Either way, two bytes right after the boundary tell
    // us which.
    if (buf[cursor] === 0x2d && buf[cursor + 1] === 0x2d) break; // "--" — final boundary
    if (buf[cursor] === CRLF[0] && buf[cursor + 1] === CRLF[1]) cursor += 2;

    const next = buf.indexOf(delimiter, cursor);
    if (next === -1) throw httpError(400, 'malformed multipart body: closing boundary not found');

    // Each part's own content ends right before the CRLF that precedes the
    // next boundary — that CRLF belongs to the boundary line, not the part.
    let end = next;
    if (buf[end - 2] === CRLF[0] && buf[end - 1] === CRLF[1]) end -= 2;
    rawParts.push(buf.subarray(cursor, end));
    cursor = next + delimiter.length;
  }

  const files: MultipartFile[] = [];
  const fields: Record<string, string> = {};

  for (const part of rawParts) {
    const headerEnd = part.indexOf(HEADER_SEP);
    if (headerEnd === -1) continue; // malformed part — skip rather than fail the whole request
    const headerText = part.subarray(0, headerEnd).toString('utf8');
    const body = part.subarray(headerEnd + HEADER_SEP.length);

    const dispositionLine = headerText
      .split('\r\n')
      .find((line) => /^content-disposition:/i.test(line));
    if (!dispositionLine) continue;

    const nameMatch = /name="([^"]*)"/.exec(dispositionLine);
    const filenameMatch = /filename="([^"]*)"/.exec(dispositionLine);
    const name = nameMatch?.[1] ?? '';
    if (!name) continue;

    if (filenameMatch) {
      const contentTypeLine = headerText.split('\r\n').find((line) => /^content-type:/i.test(line));
      const contentType = contentTypeLine?.slice(contentTypeLine.indexOf(':') + 1).trim() ?? 'application/octet-stream';
      files.push({ name, filename: filenameMatch[1] ?? '', contentType, data: Buffer.from(body) });
    } else {
      fields[name] = body.toString('utf8');
    }
  }

  return { files, fields };
}

/** Reads and parses a multipart/form-data request body, capped at `maxBytes` total. */
export async function readMultipart(
  req: http.IncomingMessage,
  contentType: string | undefined,
  maxBytes: number
): Promise<ParsedMultipart> {
  const boundary = extractBoundary(contentType);
  if (!boundary) throw httpError(400, 'expected multipart/form-data with a boundary');
  const buf = await readBodyCapped(req, maxBytes);
  return parseMultipartBuffer(buf, boundary);
}
