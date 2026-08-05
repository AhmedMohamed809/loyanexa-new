// apps/demo/views/html.ts — HTML escaping.
//
// Its own module because it is the one thing every view needs and nothing
// else in a view should reach back into server.ts for. Kept deliberately
// small: if this file ever grows a second responsibility, that responsibility
// belongs somewhere else.

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
