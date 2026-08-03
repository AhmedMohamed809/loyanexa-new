// .env — parsed by hand, no dotenv dependency. Sets process.env values that
// aren't already set (so a real shell env always wins). Never logs values.
//
// Pulled out of server.ts so apps/demo/test/*.test.ts can load the same
// .env (for DATABASE_URL) before dynamically importing anything that
// constructs a PrismaClient — @loyanexa/db reads process.env.DATABASE_URL
// at module-load time, so it must already be set by then.

import fs from 'node:fs';

export function loadEnvFile(envPath: string): void {
  let text: string;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env is fine; DATABASE_URL etc. may already be in the shell env
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
