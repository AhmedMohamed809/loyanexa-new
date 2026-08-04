#!/usr/bin/env node
// scripts/create-merchant.ts — provisions a Merchant account from the
// command line, so the owner can create (or set a password on) an account
// after deploy without going through the public sign-up form.
//
// Idempotent by email: if a Merchant with the given email already exists —
// as the live database's pre-auth demo merchant does (created by the old
// getOrCreateMerchant(), email ahmedabdulalgane@gmail.com) — this UPDATES
// that row's name/password rather than inserting a second one. That is
// deliberate: it is what lets the owner's already-live Cards stay attached
// to the same Merchant.id after this branch ships, instead of being
// orphaned by a fresh row with a new id.
//
// Never hard-codes a password: it is read from --password, or from the
// MERCHANT_PASSWORD environment variable if --password is omitted (handy
// for a one-shot `fly ssh console` invocation without it landing in shell
// history) — never a literal in this file.
//
// Usage:
//   node scripts/create-merchant.ts --email owner@example.com --name "Shami Bakery" --password 'a strong passphrase'
//   MERCHANT_PASSWORD='a strong passphrase' node scripts/create-merchant.ts --email owner@example.com --name "Shami Bakery"

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../apps/demo/env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));

const { prisma } = await import('../packages/db/src/index.ts');
const { hashPassword, validatePassword, normalizeEmail } = await import('../apps/demo/auth.ts');

interface Args {
  email?: string;
  name?: string;
  password?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email') args.email = argv[++i];
    else if (arg === '--name') args.name = argv[++i];
    else if (arg === '--password') args.password = argv[++i];
    else if (arg?.startsWith('--email=')) args.email = arg.slice('--email='.length);
    else if (arg?.startsWith('--name=')) args.name = arg.slice('--name='.length);
    else if (arg?.startsWith('--password=')) args.password = arg.slice('--password='.length);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emailRaw = args.email;
  const name = args.name?.trim();
  const password = args.password ?? process.env.MERCHANT_PASSWORD;

  if (!emailRaw || !name || !password) {
    console.error(
      'Usage: node scripts/create-merchant.ts --email <email> --name "<business name>" --password "<password>"\n' +
        '       (or set MERCHANT_PASSWORD in the environment instead of --password)'
    );
    process.exitCode = 1;
    return;
  }

  const email = normalizeEmail(emailRaw);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_RE.test(email)) {
    console.error(`"${emailRaw}" is not a valid email address.`);
    process.exitCode = 1;
    return;
  }

  const passwordCheck = validatePassword(password);
  if (!passwordCheck.ok) {
    console.error(
      passwordCheck.reason === 'too_short'
        ? 'Password must be at least 10 characters.'
        : 'That password is too common — please choose a different one.'
    );
    process.exitCode = 1;
    return;
  }

  const passwordHash = hashPassword(password);

  const existing = await prisma.merchant.findUnique({ where: { email } });
  if (existing) {
    const updated = await prisma.merchant.update({
      where: { id: existing.id },
      data: { name, passwordHash },
    });
    console.log(`Updated existing merchant ${updated.id} (${updated.email}) — password set, name set to "${updated.name}".`);
    const cardCount = await prisma.card.count({ where: { merchantId: updated.id } });
    console.log(`This account already owns ${cardCount} card(s) — they remain attached, nothing was orphaned.`);
    return;
  }

  const created = await prisma.merchant.create({ data: { email, name, passwordHash } });
  console.log(`Created merchant ${created.id} (${created.email}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
