#!/usr/bin/env node
// scripts/serve-pass.ts
//
// Tiny local server so a phone on the same wifi can open a URL and have
// Apple Wallet offer to install the demo pass built by make-demo-pass.ts.
// No dependencies: node:http, node:fs, node:os only.
//
// The whole point is the Content-Type on /pass. iOS decides whether to hand
// a download to Wallet based on the MIME type, not the file extension —
// serve application/octet-stream and the phone just downloads a file it
// cannot open. It must be exactly application/vnd.apple.pkpass.

import { createServer, type ServerResponse } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const PORT = 8087;
// 0.0.0.0 is genuinely required here — a phone on the same wifi has to
// reach this. It cannot leak key material and has no path-traversal
// surface, but it does serve a file carrying the Team ID, Pass Type ID and
// serial, so it shouldn't sit at a guessable path indefinitely on whatever
// network the laptop later joins. A random per-run token plus a self-
// timeout below narrow that window.
const HOST = '0.0.0.0';
const PASS_PATH = path.join(homedir(), 'Downloads', 'LoyaNexa-demo.pkpass');
const PASS_FILENAME = 'LoyaNexa-demo.pkpass';
const TOKEN = randomBytes(8).toString('hex');
const PASS_URL_PATH = `/pass/${TOKEN}`;
const LIFETIME_MS = 10 * 60_000;

if (!existsSync(PASS_PATH)) {
  console.error(`No pass found at ${PASS_PATH}.`);
  console.error('Run `node scripts/make-demo-pass.ts` first to build and sign it.');
  process.exit(1);
}

function lanAddress() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function sendHtml(res: ServerResponse): void {
  const passUrl = PASS_URL_PATH;
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoyaNexa demo pass</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    background: #203757;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    padding: 24px;
    box-sizing: border-box;
    text-align: center;
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 2rem; }
  a.add {
    display: inline-block;
    background: #F96400;
    color: #fff;
    text-decoration: none;
    font-size: 1.5rem;
    font-weight: 700;
    padding: 1.25rem 2rem;
    border-radius: 14px;
  }
</style>
</head>
<body>
  <h1>LoyaNexa demo pass</h1>
  <a class="add" href="${passUrl}">Add to Apple Wallet</a>
</body>
</html>
`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendPass(res: ServerResponse): void {
  const { size } = statSync(PASS_PATH);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.pkpass',
    'Content-Disposition': `attachment; filename="${PASS_FILENAME}"`,
    'Content-Length': size,
  });
  createReadStream(PASS_PATH).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    sendHtml(res);
  } else if (url.pathname === PASS_URL_PATH) {
    sendPass(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, HOST, () => {
  const ip = lanAddress();
  const minutes = Math.round(LIFETIME_MS / 60_000);
  console.log(`Serving ${PASS_PATH}`);
  console.log(`Local:  http://127.0.0.1:${PORT}/`);
  console.log(`        http://127.0.0.1:${PORT}${PASS_URL_PATH}`);
  if (ip) {
    console.log(`Phone:  http://${ip}:${PORT}/  (open this on the iPhone, same wifi)`);
    console.log(`        http://${ip}:${PORT}${PASS_URL_PATH}`);
  } else {
    console.log('No LAN IPv4 address found — connect to wifi to reach this from a phone.');
  }
  console.log(`This server will stop itself in ${minutes} minutes.`);
});

// Don't leave a pass carrying the Team ID, Pass Type ID and serial
// reachable indefinitely on whatever network the laptop later joins.
setTimeout(() => process.exit(0), LIFETIME_MS).unref();
