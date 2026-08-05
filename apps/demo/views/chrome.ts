// apps/demo/views/chrome.ts — the shell every merchant page is rendered into.
//
// Extracted from server.ts on 5 August 2026. server.ts had grown past 7,000
// lines, which makes it hard to answer "where is this drawn?" — and the
// answer for anything visible on every page was "somewhere in the middle of
// the router file".
//
// What lives here is exactly the chrome: the design tokens and stylesheet
// (CHROME_CSS), the desktop top bar (navBar), the mobile bottom tab bar
// (tabBar), and the document shell that assembles them (layout). Page bodies
// stay with the handlers that build them — this module knows how a page is
// FRAMED, never what any particular page says.
//
// One rule worth keeping: CHROME_CSS is emitted by both this module's
// layout() and by the standalone stamp screen in server.ts, and nowhere else.
// It used to be copied, and the copy drifted — the /stamp bar lost its
// background and its buttons lost their styling entirely, because that copy's
// :root never declared --sunk and never declared .btn. A test now walks every
// merchant page and fails if a second :root block ever appears.

import { t, type Lang } from '../../../packages/i18n/src/index.ts';
import { escapeHtml } from './html.ts';

export const CHROME_CSS = `
  :root {
    --canvas: #0F172A;
    --paper: #1C2A42;
    --sunk: #162338;
    --raise: #22314C;
    --accent: #F28C38;
    --accent-hover: #E67E22;
    --accent-light: #F7B267;
    --on-accent: #0F172A;
    --ink: #FFFFFF;
    --ink-2: #CBD5E1;
    --ink-3: #94A3B8;
    --line: rgba(255,255,255,.10);
    --green: #22C55E;
    --red: #EF4444;
    --amber: #F7B267;
    --radius: 14px;
    --radius-lg: 18px;

    /* Motion and depth. Durations are short and every easing is ease-out:
       interface motion exists to explain where something came from, not to
       perform. Past ~250ms it starts to feel like waiting, and anything that
       overshoots or bounces reads as a toy. */
    --dur-1: 120ms;   /* a state change on something already under the cursor */
    --dur-2: 180ms;   /* the default */
    --dur-3: 280ms;   /* something entering or leaving the page */
    --ease: cubic-bezier(.22, .61, .36, 1);
    --shadow-1: 0 1px 2px rgba(0,0,0,.28);
    --shadow-2: 0 10px 24px rgba(0,0,0,.34);
    --shadow-3: 0 20px 48px rgba(0,0,0,.44);
  }
  /* -------------------------------------------------------------------
     Motion and depth.

     One place, one vocabulary. Durations are short and easings are all
     ease-out: interface motion is meant to explain where something came
     from, not to perform. Anything past ~250ms starts to feel like waiting,
     and anything that overshoots or bounces reads as a toy.
     ------------------------------------------------------------------- */
  /* Everyone who has asked the system not to animate gets no animation. This
     is not a nicety: for people with vestibular disorders, motion they did
     not ask for can cause actual nausea. The block is placed first so nothing
     below can reintroduce movement by being more specific. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .001ms !important;
      scroll-behavior: auto !important;
    }
  }

  @keyframes lnx-rise {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes lnx-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* Page entrance. Staggered by a few tens of milliseconds so the eye is led
     down the page in reading order instead of everything appearing at once.
     Capped at six: past that the last element waits noticeably, and a wait is
     the opposite of what this is for. */
  main > * { animation: lnx-rise var(--dur-3) var(--ease) both; }
  main > *:nth-child(1) { animation-delay: 0ms; }
  main > *:nth-child(2) { animation-delay: 40ms; }
  main > *:nth-child(3) { animation-delay: 80ms; }
  main > *:nth-child(4) { animation-delay: 120ms; }
  main > *:nth-child(5) { animation-delay: 160ms; }
  main > *:nth-child(n+6) { animation-delay: 200ms; }

  /* Grid children enter in sequence rather than as a block. Cards and
     template tiles are the two places where a whole grid appears at once,
     and a wall of tiles materialising in one frame reads as a page redraw;
     the same tiles arriving in reading order reads as a page being laid out.
     Capped at eight — past that the tail is a wait, not an entrance. */
  .cards-grid > *, .kpis > * { animation: lnx-rise var(--dur-3) var(--ease) both; }
  .cards-grid > *:nth-child(1), .kpis > *:nth-child(1) { animation-delay: 30ms; }
  .cards-grid > *:nth-child(2), .kpis > *:nth-child(2) { animation-delay: 60ms; }
  .cards-grid > *:nth-child(3), .kpis > *:nth-child(3) { animation-delay: 90ms; }
  .cards-grid > *:nth-child(4), .kpis > *:nth-child(4) { animation-delay: 120ms; }
  .cards-grid > *:nth-child(5) { animation-delay: 150ms; }
  .cards-grid > *:nth-child(6) { animation-delay: 180ms; }
  .cards-grid > *:nth-child(7) { animation-delay: 210ms; }
  .cards-grid > *:nth-child(n+8) { animation-delay: 240ms; }

  /* The simulation is the thing being explained, so it arrives from the side
     it lives on. A logical translate would be ideal; since there is no such thing,
     the RTL variant is written explicitly rather than left to drift. */
  @keyframes lnx-slide-in { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
  @keyframes lnx-slide-in-rtl { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: none; } }
  .sim-rail { animation: lnx-slide-in var(--dur-3) var(--ease) both; animation-delay: 120ms; }
  html[dir="rtl"] .sim-rail { animation-name: lnx-slide-in-rtl; }

  /* The card mock reacts to its own colour changing. Because the merchant is
     dragging a colour picker, this has to be quick — a slow crossfade turns
     a live preview into a laggy one. */
  .sim-card { transition: background-color var(--dur-2) var(--ease), color var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease); }
  .sim-card:hover { box-shadow: var(--shadow-3); }
  .sim-strip { transition: opacity var(--dur-1) var(--ease); }

  /* Tab bar: the active tab's icon settles rather than snapping. */
  .tabbar .tab { transition: color var(--dur-1) var(--ease), background-color var(--dur-1) var(--ease); }
  .tabbar .tabicon { transition: transform var(--dur-2) var(--ease); }
  .tabbar .tab.active .tabicon { transform: translateY(-1px) scale(1.06); }
  /* The More sheet opens rather than appearing. */
  .tab-more[open] .more-sheet { animation: lnx-rise var(--dur-2) var(--ease) both; }

  /* Top nav: the pill grows into place under the pointer. */
  header.top nav.nav a { transition: color var(--dur-1) var(--ease), background-color var(--dur-1) var(--ease); }

  /* Anything that just changed state should say so once, quietly. */
  @keyframes lnx-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(242,140,56,.45); }
    100% { box-shadow: 0 0 0 12px rgba(242,140,56,0); }
  }
  .ok-banner { animation: lnx-rise var(--dur-3) var(--ease) both, lnx-pulse 900ms var(--ease) 1; }

  /* Table rows and list items settle in on load, in reading order. */
  table.data tbody tr { animation: lnx-fade var(--dur-2) var(--ease) both; }
  table.data tbody tr:nth-child(1) { animation-delay: 20ms; }
  table.data tbody tr:nth-child(2) { animation-delay: 40ms; }
  table.data tbody tr:nth-child(3) { animation-delay: 60ms; }
  table.data tbody tr:nth-child(4) { animation-delay: 80ms; }
  table.data tbody tr:nth-child(n+5) { animation-delay: 100ms; }

  /* Links in prose. Underline grows from the start edge, which is the right
     edge in Arabic — hence a logical property rather than left/right. */
  a:not(.btn):not(.card-tile):not(.tpl-tile) { transition: color var(--dur-1) var(--ease); }

  /* Keyboard focus, visible and consistent.
     :focus-visible rather than :focus, so a ring appears for keyboard users
     and not around every button a mouse happens to click. */
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 6px;
  }

  html[lang="ar"] * { letter-spacing: 0 !important; }
  /* Arabic letterforms have deeper ascenders and descenders, so the same
     line-height that suits Latin runs tight in Arabic. */
  html[lang="ar"] body { line-height: 1.75; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font-family: 'IBM Plex Sans Arabic', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    /* The family stops at 700. Without this, asking for a heavier weight makes
       the browser smear the outlines into a fake bold — subtly wrong in a way
       that is hard to name and easy to feel. Fail visibly instead. */
    font-synthesis-weight: none;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  /* Form controls do not inherit the family by default. */
  button, input, select, textarea { font-family: inherit; }
  /* A proportional face gives digits different widths, so figures jitter
     between rows. Tabular figures keep numeric columns aligned. */
  table.data td, table.data th, .kpi .n, .num, code.pill { font-variant-numeric: tabular-nums; }
  header.top {
    background: var(--sunk);
    border-bottom: 1px solid var(--line);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    gap: 28px;
  }
  header.top a.brand { color: var(--ink); text-decoration: none; font-weight: 700; font-size: 17px; letter-spacing: 0.2px; }
  header.top nav.nav { display: flex; gap: 4px; flex-wrap: wrap; margin-inline-start: auto; }
  header.top nav.nav a {
    color: var(--ink-2); text-decoration: none; font-weight: 600; font-size: 14px;
    padding: 8px 14px; border-radius: 100px;
  }
  header.top nav.nav a:hover { color: var(--ink); background: var(--raise); }
  header.top nav.nav a.active { color: var(--on-accent); background: var(--accent); }

  header.top nav.nav a.lang-toggle {
    border: 1px solid var(--line);
    margin-inline-start: 8px;
    color: var(--ink-3);
  }
  header.top nav.nav a.lang-toggle:hover { color: var(--ink); border-color: var(--accent); }

  /* -------------------------------------------------------------------
     Mobile bottom tab bar (owner's ask, 2026-08-04). Hidden by default and
     shown only under 720px, where the top nav's links are hidden in turn —
     exactly one of the two is ever visible, so nothing is duplicated for a
     screen reader or a keyboard user.
     ------------------------------------------------------------------- */
  .tabbar { display: none; }

  @media (max-width: 720px) {
    /* The top bar keeps the brand and becomes a slim title bar; its links
       move to the bottom. Sign out goes with them (it lives in More), or a
       destructive action sits under the thumb on every page. */
    header.top { padding: 12px 16px; gap: 12px; }
    header.top nav.nav,
    header.top form { display: none; }

    .tabbar {
      display: flex;
      position: fixed;
      inset-inline: 0;
      bottom: 0;
      z-index: 50;
      background: color-mix(in srgb, var(--sunk) 92%, transparent);
      backdrop-filter: saturate(160%) blur(12px);
      -webkit-backdrop-filter: saturate(160%) blur(12px);
      border-top: 1px solid var(--line);
      /* The home-indicator inset. Without it the last row of labels sits
         under the gesture bar on every modern iPhone. */
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    .tabbar .tab {
      flex: 1 1 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 9px 2px 7px;
      color: var(--ink-3);
      text-decoration: none;
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1.1;
      text-align: center;
      /* 48px keeps every tab at the accessible minimum target even at five
         across a 320px phone. */
      min-height: 48px;
      background: none;
      border: 0;
      cursor: pointer;
      /* Kills the grey flash iOS paints over a tapped link. */
      -webkit-tap-highlight-color: transparent;
    }
    .tabbar .tab span {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tabbar .tabicon { width: 23px; height: 23px; flex: none; }
    .tabbar .tab.active { color: var(--accent); }
    /* Pressed state only — no :hover, which sticks after a tap on touch. */
    .tabbar .tab:active { background: var(--raise); }

    /* "More" is a <details> sheet: no JavaScript, and it closes on Escape
       and on a second tap for free. */
    .tab-more { flex: 1 1 0; display: flex; position: relative; }
    .tab-more > summary { list-style: none; width: 100%; }
    .tab-more > summary::-webkit-details-marker { display: none; }
    .more-sheet {
      position: absolute;
      bottom: calc(100% + 8px);
      inset-inline-end: 6px;
      min-width: 190px;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 6px;
      box-shadow: 0 18px 40px rgba(0,0,0,.45);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .more-sheet a,
    .more-sheet button {
      display: block;
      width: 100%;
      text-align: start;
      padding: 12px 14px;
      border-radius: 10px;
      color: var(--ink-2);
      text-decoration: none;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      background: none;
      border: 0;
      cursor: pointer;
    }
    .more-sheet a:active,
    .more-sheet button:active { background: var(--raise); color: var(--ink); }
    .more-sheet form { margin: 0; }

    /* Clears the fixed bar so the last element on a page is never trapped
       underneath it. */
    main { padding-bottom: calc(76px + env(safe-area-inset-bottom, 0px)); }
  }
  .btn {
    display: inline-block;
    background: var(--accent);
    color: var(--on-accent);
    border: none;
    border-radius: 100px;
    padding: 12px 22px;
    font-weight: 700;
    font-size: 15px;
    text-decoration: none;
    cursor: pointer;
    font-family: inherit;
  }
  .btn { transition: background-color var(--dur-1) var(--ease), transform var(--dur-1) var(--ease), box-shadow var(--dur-2) var(--ease); box-shadow: var(--shadow-1); }
  .btn:hover { background: var(--accent-hover); box-shadow: var(--shadow-2); }
  /* A press should be felt. 1px is enough — anything more looks like a
     bounce, and a button that bounces reads as a toy. */
  .btn:active { transform: translateY(1px); box-shadow: var(--shadow-1); }
  .btn.secondary {
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--line);
  }
  .btn.secondary:hover { background: var(--raise); }
  .btn[disabled] { opacity: .5; cursor: default; }
`;

export type NavKey = 'cards' | 'customers' | 'reports' | 'stamp' | 'notifications' | 'settings';

/** The top nav bar BUILD.md §6 wants reachable from every merchant page: Cards · Customers · Reports · Stamp screen · Settings (this build's revision of the historical bottom tab bar list; Settings — BUILD.md §8.13 — added alongside staff PINs and location reminders). Shared between layout() below and renderStampScreen() *only when viewed as the merchant* — a staff session gets its own, deliberately shorter header (see renderStampScreen's own doc comment) that omits every link a staff session cannot reach. */
export function navBar(active: NavKey | undefined, lang: Lang = 'en'): string {
  const items: Array<{ key: NavKey; href: string; label: string }> = [
    { key: 'cards', href: '/app', label: t(lang, 'navCards') },
    { key: 'customers', href: '/customers', label: t(lang, 'navCustomers') },
    { key: 'reports', href: '/reports', label: t(lang, 'navReports') },
    { key: 'stamp', href: '/stamp', label: t(lang, 'navStamp') },
    { key: 'notifications', href: '/notifications', label: t(lang, 'navNotifications') },
    { key: 'settings', href: '/settings', label: t(lang, 'navSettings') },
  ];
  const otherLang: Lang = lang === 'ar' ? 'en' : 'ar';
  return `<header class="top">
  <a class="brand" href="/app">LoyaNexa</a>
  <nav class="nav">
    ${items
      .map(
        (i) =>
          `<a href="${i.href}"${i.key === active ? ' class="active" aria-current="page"' : ''}>${escapeHtml(i.label)}</a>`
      )
      .join('\n    ')}
    <a class="lang-toggle" href="/lang/${otherLang}" lang="${otherLang}">${escapeHtml(t(lang, 'navSwitchLang'))}</a>
  </nav>
  <form method="POST" action="/signout" style="margin:0;">
    <button type="submit" class="btn secondary small">${escapeHtml(t(lang, 'navSignOut'))}</button>
  </form>
</header>`;
}

/**
 * The five tab-bar icons, as inline SVG paths.
 *
 * Inline and not an icon font or sprite sheet: the tab bar is on every
 * merchant page, and BUILD.md's "no framework, no bundler" rule applies to
 * the dashboard too. `stroke="currentColor"` is what lets one path serve
 * both the muted and the active-accent state without a second asset.
 * `vector-effect` is deliberately omitted — these render at a single size.
 */
const TAB_ICONS: Record<TabKey, string> = {
  cards: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/>',
  customers: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.2 19.2a6 6 0 0 1 11.6 0"/><path d="M16.5 6.2a3 3 0 0 1 0 5.6"/><path d="M17.6 14.4a5.6 5.6 0 0 1 3.2 4.8"/>',
  stamp: '<circle cx="12" cy="12" r="8.2"/><path d="M8.6 12.2l2.3 2.3 4.5-4.6"/>',
  notifications: '<path d="M12 3.5a5.6 5.6 0 0 0-5.6 5.6c0 4-1.5 5.4-1.5 5.4h14.2s-1.5-1.4-1.5-5.4A5.6 5.6 0 0 0 12 3.5Z"/><path d="M10.3 18a1.9 1.9 0 0 0 3.4 0"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
};

export type TabKey = 'cards' | 'customers' | 'stamp' | 'notifications' | 'more';

/**
 * The mobile bottom tab bar (owner's ask, 2026-08-04: *"when I open the
 * website on the mobile phone I need to see the nav bar at the bottom, and
 * it should look like a mobile application"*).
 *
 * Five tabs, not the top nav's six. Native tab bars cap at five because
 * below ~64px a target stops being reliably tappable — Reports and Settings
 * move into "More", which is a pure-CSS `<details>` sheet needing no
 * JavaScript. Reports is the one judgement call here: it is genuinely useful
 * but not a per-shift action, whereas Stamp is used dozens of times a day
 * and keeps its own tab.
 *
 * `active` reuses NavKey so a page never has to know about both navs; the
 * two Reports/Settings keys simply light up the More tab instead.
 *
 * The bar is hidden entirely above 720px, where the top nav takes over — so
 * desktop is untouched and only one of the two is ever visible.
 */
export function tabBar(active: NavKey | undefined, lang: Lang = 'en'): string {
  const tabs: Array<{ key: TabKey; href: string; label: string }> = [
    { key: 'cards', href: '/app', label: t(lang, 'navCards') },
    { key: 'customers', href: '/customers', label: t(lang, 'navCustomers') },
    { key: 'stamp', href: '/stamp', label: t(lang, 'navStamp') },
    { key: 'notifications', href: '/notifications', label: t(lang, 'navNotifications') },
  ];
  // Reports and Settings have no tab of their own, so they light up "More".
  const activeTab: TabKey | undefined =
    active === 'reports' || active === 'settings' ? 'more' : active;

  const icon = (key: TabKey): string =>
    `<svg class="tabicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICONS[key]}</svg>`;

  const links = tabs
    .map(
      (tab) =>
        `<a href="${tab.href}" class="tab${tab.key === activeTab ? ' active' : ''}"${
          tab.key === activeTab ? ' aria-current="page"' : ''
        }>${icon(tab.key)}<span>${escapeHtml(tab.label)}</span></a>`
    )
    .join('\n    ');

  const otherLang: Lang = lang === 'ar' ? 'en' : 'ar';
  return `<nav class="tabbar" aria-label="${escapeHtml(t(lang, 'navPrimary'))}">
    ${links}
    <details class="tab-more">
      <summary class="tab${activeTab === 'more' ? ' active' : ''}">${icon('more')}<span>${escapeHtml(t(lang, 'navMore'))}</span></summary>
      <div class="more-sheet">
        <a href="/reports">${escapeHtml(t(lang, 'navReports'))}</a>
        <a href="/settings">${escapeHtml(t(lang, 'navSettings'))}</a>
        <a href="/lang/${otherLang}">${escapeHtml(t(lang, 'navSwitchLang'))}</a>
        <form method="POST" action="/signout"><button type="submit">${escapeHtml(t(lang, 'navSignOut'))}</button></form>
      </div>
    </details>
  </nav>`;
}


/**
 * The page-level stylesheet: panels, forms, inputs, tables, grids — every
 * rule that is about a PAGE rather than about the frame around it.
 *
 * Split out on 5 August 2026 because the original split was arbitrary and
 * silently wrong. CHROME_CSS held the tokens, the header and the tab bar,
 * while everything else lived inline inside layout(). Any shell that was not
 * layout() therefore emitted half a stylesheet — and three of them are not:
 * the stamp screen, the legal pages, and the sign-in page.
 *
 * That is why sign-in rendered two browser-default white boxes: the rule that
 * gives an input its background and border was in the half those shells never
 * saw. Nothing in the markup was wrong, and nothing failed a typecheck.
 *
 * Emit both constants together, always. A shell may have its own extra rules;
 * it may not have a subset of these.
 */
export const PAGE_CSS = `
  main {
    max-width: 1000px;
    margin: 0 auto;
    padding: 24px 20px 64px;
  }
  .banner {
    background: rgba(242,140,56,.10);
    border: 1px solid rgba(242,140,56,.30);
    color: var(--accent-light);
    border-radius: var(--radius-lg);
    padding: 14px 18px;
    margin-bottom: 20px;
    font-size: 14px;
    line-height: 1.5;
  }
  .banner b { color: var(--ink); }
  .panel {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin-bottom: 20px;
    box-shadow: var(--shadow-1);
  }
  h1 { font-size: 24px; margin: 0 0 6px; color: var(--ink); }
  h2 { font-size: 16px; margin: 0 0 14px; color: var(--ink); }
  p { line-height: 1.5; }
  .muted { color: var(--ink-3); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  }
  .card-tile {
    display: block;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    overflow: hidden;
    text-decoration: none;
    color: inherit;
    transition: transform var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease);
  }
  /* Lift is reserved for things that actually go somewhere. A panel that
     rises under the cursor but does nothing when clicked is a small lie. */
  .card-tile:hover { transform: translateY(-2px); box-shadow: var(--shadow-2); border-color: rgba(242,140,56,.45); }
  .card-tile:active { transform: translateY(0); }
  .card-tile img { display: block; width: 100%; height: auto; background: var(--sunk); }
  .card-tile .meta { padding: 14px 16px; border-top: 1px solid var(--line); }
  .card-tile .meta h3 { margin: 0 0 4px; font-size: 15px; color: var(--ink); }
  .card-tile .meta p { margin: 0; font-size: 13px; color: var(--ink-3); }
  .empty {
    text-align: center;
    padding: 48px 24px;
  }
  form .field { margin-bottom: 18px; }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--ink-2); }
  /* Every text-entry type, not a subset.
     email and password were missing from this list, which is why the sign-in
     page rendered two browser-default white boxes on a dark panel — they were
     picking up the focus ring and the transition added later, but never the
     background, border or colour that make an input look like part of the
     product. A selector list is exactly the kind of thing that gets extended
     by one type at a time and quietly falls behind. */
  input[type="text"], input[type="number"], input[type="tel"], input[type="email"],
  input[type="password"], input[type="search"], input[type="date"], input[type="url"],
  select, textarea {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 15px;
    background: var(--sunk);
    color: var(--ink);
    font-family: inherit;
  }
  select { appearance: auto; }
  input[type="text"], input[type="number"], input[type="tel"], input[type="email"],
  input[type="password"], input[type="search"], input[type="date"], select, textarea {
    transition: border-color var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease), background-color var(--dur-1) var(--ease);
  }
  input[type="text"]:focus, input[type="number"]:focus, input[type="tel"]:focus,
  input[type="email"]:focus, input[type="password"]:focus, input[type="search"]:focus,
  input[type="date"]:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
    /* A ring rather than a thicker border, so nothing reflows on focus. */
    box-shadow: 0 0 0 3px rgba(242,140,56,.18);
    background: var(--raise);
  }
  input[disabled], select[disabled], textarea[disabled] { opacity: .55; cursor: not-allowed; }
  input[type="range"] { width: 100%; }
  input[type="color"] {
    width: 56px;
    height: 40px;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 2px;
    background: var(--paper);
  }
  .colors { display: flex; gap: 24px; flex-wrap: wrap; }
  .colors .field { margin-bottom: 0; }
  .preview-panel { text-align: center; background: var(--sunk); border: 1px dashed var(--line); border-radius: var(--radius-lg); padding: 20px; }
  /* height:auto is not optional here. The <img> carries width/height
     attributes (375x144) so the browser can reserve the space before the
     image loads and avoid a layout jump — but once max-width shrinks the
     width on a narrow screen, a fixed height attribute keeps the old height
     and the strip is stretched. On a 430px phone the inline max-width:375px
     this replaces also beat the stylesheet on specificity, so the strip
     overflowed its own panel on both sides. */
  .preview-panel img { max-width: 100%; height: auto; }
  .error { background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.35); color: #FCA5A5; border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; font-size: 14px; }
  /* A caution that is not an error: the card-delete consequences, an
     unrecognised template code. Amber rather than red — the user has not
     done anything wrong yet. */
  .warn { background: rgba(247,178,103,.10); border: 1px solid rgba(247,178,103,.32); color: var(--amber); border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; font-size: 14px; line-height: 1.5; }
  .error, .warn, .ok-banner { animation: lnx-rise var(--dur-3) var(--ease) both; }
  .ok-banner { background: rgba(34,197,94,.10); border: 1px solid rgba(34,197,94,.32); color: #86EFAC; border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; font-size: 14px; }

  /* -------------------------------------------------------------------
     Live card simulation (owner's ask, 5 Aug 2026: "simulate that card on
     the right or the left, depending on the language, so he can imagine the
     design before releasing it").

     Which side it lands on needs no logic: it is simply the second column of
     a two-column grid, and the document's own dir flips that to the left in
     Arabic. Writing an explicit right:0 here would have to be undone for RTL; letting
     the grid do it means there is nothing to undo.
     ------------------------------------------------------------------- */
  .with-sim { display: grid; grid-template-columns: minmax(0,1fr) 340px; gap: 26px; align-items: start; }
  .sim-rail { position: sticky; top: 20px; }
  .sim-head { font-size: 13px; font-weight: 600; color: var(--ink-3); margin: 0 0 10px; }
  .sim-card {
    border-radius: 18px;
    padding: 18px 18px 16px;
    border: 1px solid rgba(255,255,255,.14);
    /* A wallet pass sits on the phone's own surface, so it carries a real
       shadow. Without one the mock reads as a flat swatch of colour rather
       than as a card. */
    box-shadow: 0 18px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.10);
    transition: background-color .25s ease, color .25s ease;
  }
  .sim-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .sim-brand { font-size: 13px; font-weight: 600; opacity: .9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sim-chip { font-size: 10px; font-weight: 600; letter-spacing: .06em; opacity: .65; text-transform: uppercase; }
  html[lang="ar"] .sim-chip { text-transform: none; letter-spacing: 0; }
  .sim-reward { font-size: 21px; font-weight: 700; line-height: 1.25; margin: 0 0 14px; word-break: break-word; }
  .sim-strip { display: block; width: 100%; height: auto; border-radius: 10px; }
  .sim-foot { margin-top: 12px; font-size: 12px; opacity: .78; display: flex; justify-content: space-between; gap: 10px; }
  .sim-hint { margin: 12px 2px 0; font-size: 12px; color: var(--ink-3); line-height: 1.5; }
  @media (max-width: 900px) {
    /* Below this the two columns would each be too narrow to read, so the
       simulation moves above the form — where it is still the first thing
       seen, which is the point of it. */
    .with-sim { grid-template-columns: 1fr; }
    .sim-rail { position: static; order: -1; }
  }

  /* Plan usage bars (BUILD.md §14). A limit discovered only by hitting it is
     a bad limit; "2 / 3" answers the question before it is asked. */
  .plan-row { margin-bottom: 14px; }
  .plan-row-top { display: flex; justify-content: space-between; font-size: 14px; color: var(--ink-2); margin-bottom: 6px; }
  .plan-usage { font-variant-numeric: tabular-nums; color: var(--ink-3); }
  .plan-bar { height: 6px; border-radius: 100px; background: var(--sunk); overflow: hidden; }
  .plan-bar > span {
    display: block; height: 100%; background: var(--accent); border-radius: 100px;
    transition: width var(--dur-3) var(--ease);
  }

  /* Setup checklist (BUILD.md §8.3). A band, not a panel: it sits above the
     page's own content and has to read as guidance rather than as another
     thing to manage. Collapsible via <details>, so remembering the open state
     costs no JavaScript and no cookie. */
  .setup {
    background: linear-gradient(180deg, rgba(242,140,56,.09), rgba(242,140,56,.03));
    border: 1px solid rgba(242,140,56,.26);
    border-radius: var(--radius-lg);
    padding: 14px 18px;
    margin-bottom: 20px;
    animation: lnx-rise var(--dur-3) var(--ease) both;
  }
  .setup > summary {
    display: flex; align-items: center; gap: 12px; cursor: pointer;
    list-style: none; font-size: 14px;
  }
  .setup > summary::-webkit-details-marker { display: none; }
  .setup .setup-title { font-weight: 700; color: var(--ink); }
  .setup .setup-count { color: var(--accent-light); font-weight: 600; margin-inline-start: auto; font-variant-numeric: tabular-nums; }
  .setup-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .setup-pill {
    display: inline-flex; align-items: center; gap: 8px;
    border: 1px solid var(--line); border-radius: 100px;
    padding: 8px 15px; font-size: 13px; font-weight: 600;
    color: var(--ink-2); text-decoration: none; background: var(--sunk);
    transition: border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease), transform var(--dur-1) var(--ease);
  }
  .setup-pill:hover { color: var(--ink); border-color: var(--accent); transform: translateY(-1px); }
  .setup-pill .setup-tick {
    width: 16px; height: 16px; border-radius: 50%; flex: none;
    border: 1px solid var(--line); display: inline-flex;
    align-items: center; justify-content: center; font-size: 10px;
  }
  /* A finished step stays visible rather than disappearing: seeing what you
     have already done is most of why a checklist works. */
  .setup-pill.done { color: var(--ink-3); }
  .setup-pill.done .setup-tick { background: var(--green); border-color: var(--green); color: #0F172A; font-weight: 700; }

  /* Template gallery (BUILD.md §8.4). Reuses .cards-grid so a template tile
     and a real card tile line up on the same grid. */
  .tpl-search { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .tpl-tile {
    display: block; background: var(--paper); border: 1px solid var(--line);
    border-radius: var(--radius-lg); overflow: hidden; text-decoration: none; color: inherit;
  }
  .tpl-tile { transition: transform var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease); }
  .tpl-tile:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: var(--shadow-2); }
  .tpl-tile:active { transform: translateY(0); }
  .tpl-tile img { display: block; width: 100%; height: auto; background: var(--sunk); }
  .tpl-tile .meta { padding: 14px 16px; border-top: 1px solid var(--line); }
  .tpl-tile .meta h3 { margin: 0 0 4px; font-size: 15px; color: var(--ink); }
  .tpl-tile .meta p { margin: 0 0 4px; font-size: 13px; color: var(--ink-2); }
  .tpl-tile .tpl-sub { color: var(--ink-3); font-size: 12px; }
  .tpl-tile .tpl-sub code { font-family: inherit; letter-spacing: .04em; }
  .tpl-tile .btn.small { margin-top: 10px; }
  code.pill { background: var(--sunk); border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; font-size: 13px; color: var(--ink-2); font-family: inherit; }
  .kv { display: grid; grid-template-columns: 140px 1fr; gap: 10px 16px; font-size: 15px; }
  .kv dt { color: var(--ink-3); }
  .kv dd { margin: 0; color: var(--ink); }
  .qr-wrap { text-align: center; padding: 20px; background: var(--sunk); border-radius: var(--radius-lg); border: 1px solid var(--line); }
  .qr-wrap img { image-rendering: pixelated; border-radius: 8px; background: #fff; padding: 12px; }
  .lock { opacity: .55; }
  .lock label::after { content: ' 🔒'; }
  table.data { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.data th, table.data td { text-align: start; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  table.data tbody tr { transition: background-color var(--dur-1) var(--ease); }
  table.data tbody tr:hover { background: rgba(255,255,255,.035); }
  table.data th { color: var(--ink-3); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  table.data td { color: var(--ink); }
  table.data code.mono { font-variant-numeric: tabular-nums; letter-spacing: .04em; }
  .progress-bar { display: flex; align-items: center; gap: 8px; min-width: 120px; }
  .progress-bar .track { flex: 1; height: 6px; border-radius: 100px; background: var(--sunk); overflow: hidden; }
  .progress-bar .fill { height: 100%; background: var(--accent); }
  .progress-bar span.frac { font-size: 12px; color: var(--ink-3); white-space: nowrap; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .kpi { background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 18px 20px; }
  .kpi .n { font-size: 28px; font-weight: 700; color: var(--ink); }
  .kpi .label { font-size: 13px; color: var(--ink-3); margin-top: 4px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    display: inline-block; padding: 8px 16px; border-radius: 100px; font-size: 13px; font-weight: 600;
    border: 1px solid var(--line); color: var(--ink-2); text-decoration: none;
  }
  .chip.active { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .chip.locked { background: rgba(242,140,56,.12); color: var(--accent-light); border-color: rgba(242,140,56,.3); }
  .funnel { display: flex; flex-direction: column; gap: 12px; }
  .funnel .step { display: grid; grid-template-columns: 180px 1fr 60px; align-items: center; gap: 12px; font-size: 14px; }
  .funnel .track { height: 22px; border-radius: 8px; background: var(--sunk); overflow: hidden; }
  .funnel .fill { height: 100%; background: var(--accent); border-radius: 8px; }
  .weekday-chart { display: flex; align-items: flex-end; gap: 10px; height: 140px; }
  .weekday-chart .bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 6px; }
  .weekday-chart .bar { width: 100%; background: var(--accent); border-radius: 6px 6px 0 0; min-height: 2px; }
  .weekday-chart .day-label { font-size: 11px; color: var(--ink-3); }
  .weekday-chart .day-count { font-size: 11px; color: var(--ink-2); }
  .no-data { text-align: center; color: var(--ink-3); padding: 28px 12px; font-size: 14px; }

  /* Card designer (BUILD.md §8.5 / §8.9) — controls on the left, a live,
     sticky preview on the right; stacks to a single column with the
     preview pinned above the controls on narrow screens. */
  .designer { display: grid; grid-template-columns: 1fr 340px; gap: 20px; align-items: start; }
  .designer-controls { min-width: 0; }
  .designer-preview { position: sticky; top: 20px; }
  .designer-preview .preview-panel img { width: 100%; height: auto; border-radius: 10px; }
  .designer-preview .hint { font-size: 12px; color: var(--ink-3); margin-top: 10px; line-height: 1.5; }
  @media (max-width: 860px) {
    .designer { grid-template-columns: 1fr; }
    .designer-preview { position: static; order: -1; margin-bottom: 4px; }
  }
  .designer h2 { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); }
  .designer h2:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .upload-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .upload-thumb {
    width: 64px; height: 64px; border-radius: 10px; background: var(--sunk);
    border: 1px solid var(--line); object-fit: cover; display: none;
  }
  .upload-thumb.cover-thumb { width: 96px; height: 37px; }
  .upload-thumb.shown { display: block; }
  .upload-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  input[type="file"] { display: none; }
  .btn.small { padding: 8px 16px; font-size: 13px; }
  .btn.remove { background: transparent; color: var(--red); border: 1px solid rgba(239,68,68,.35); }
  .btn.remove:hover { background: rgba(239,68,68,.12); }
  .btn.remove[disabled] { opacity: .4; cursor: default; }
  .upload-error { color: #FCA5A5; font-size: 13px; margin-top: 6px; }
  .hex-row { display: flex; align-items: center; gap: 8px; }
  .hex-row input[type="color"] { flex: none; }
  .hex-row input[type="text"] { width: 96px; flex: none; text-transform: uppercase; }
  .range-row { display: flex; align-items: center; gap: 12px; }
  .range-row input[type="range"] { flex: 1; }
  .range-row .range-val { font-size: 13px; color: var(--ink-2); min-width: 34px; text-align: end; }
  .shape-toggle { display: flex; gap: 8px; }
  .shape-toggle label {
    display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 14px; cursor: pointer; font-weight: 500; font-size: 14px; color: var(--ink-2); margin: 0;
    flex: 1; justify-content: center;
  }
  .shape-toggle input { accent-color: var(--accent); }
  /* Card-language picker (BUILD.md §8.2's "two large cards" pattern, reused
     here for the per-card choice — BUILD.md §8.5 step 3 / §8.9). Two big,
     scannable tiles rather than a <select> buried among colour pickers,
     since a merchant should never have to read English to find "العربية". */
  .lang-toggle { display: flex; gap: 12px; flex-wrap: wrap; }
  .lang-card {
    position: relative; flex: 1; min-width: 130px; display: flex; align-items: center;
    justify-content: center; border: 2px solid var(--line); border-radius: var(--radius-lg);
    padding: 20px 16px; cursor: pointer; margin: 0; background: var(--sunk);
  }
  .lang-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; }
  .lang-card input { position: absolute; opacity: 0; width: 0; height: 0; }
  .lang-card-name { font-size: 19px; font-weight: 700; color: var(--ink); letter-spacing: 0; }
  .switch-row { display: flex; align-items: center; gap: 10px; }
  .switch-row label { margin: 0; font-weight: 500; }
  .switch-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }
  .icon-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .icon-swatch {
    position: relative; display: flex; align-items: center; justify-content: center;
    width: 52px; height: 52px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--sunk); cursor: pointer; margin: 0;
  }
  .icon-swatch.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; }
  .icon-swatch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .icon-swatch img { width: 28px; height: 28px; }
  .field-hint { font-size: 12px; color: var(--ink-3); margin-top: 4px; }
  .field-hint.amber { color: var(--amber); }

  /* Location reminders (BUILD.md §9.4/§8.13) — a variable-length list of
     fieldsets, added/removed entirely client-side (plain JS, no server
     round trip) until Save is pressed. */
  .locations-heading-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .locations-counter { font-size: 13px; color: var(--ink-3); white-space: nowrap; }
  .locations-intro { font-size: 13px; color: var(--ink-2); line-height: 1.5; margin: 4px 0 16px; }
  .locations-empty { text-align: center; color: var(--ink-3); padding: 20px 12px; font-size: 13px; border: 1px dashed var(--line); border-radius: 12px; margin-bottom: 14px; }
  .location-row { border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 12px; background: var(--sunk); }
  .location-row .row-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .location-row .row-title { font-size: 13px; font-weight: 700; color: var(--ink-2); }
  .location-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .location-grid .field { margin-bottom: 12px; }
  .location-row .geo-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .location-row .geo-status { font-size: 12px; color: var(--ink-3); }
  .location-row .geo-status.error { color: var(--red); }

  /* Settings — staff PINs (BUILD.md §8.13). */
  .staff-pin-reveal { background: rgba(34,197,94,.10); border: 1px solid rgba(34,197,94,.35); border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; }
  .staff-pin-reveal .pin { font-size: 24px; font-weight: 700; letter-spacing: 0.12em; color: var(--ink); font-variant-numeric: tabular-nums; }
  .staff-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .staff-row:last-child { border-bottom: none; }
  .staff-row .name { font-weight: 600; color: var(--ink); }
  .staff-row .badge { font-size: 11px; padding: 3px 10px; border-radius: 100px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .staff-row .badge.active { background: rgba(34,197,94,.14); color: var(--green); }
  .staff-row .badge.inactive { background: rgba(148,163,184,.14); color: var(--ink-3); }
  .staff-row .actions { display: flex; gap: 8px; }
  .settings-note { font-size: 13px; color: var(--ink-3); line-height: 1.5; margin: 6px 0 18px; }

  /* Notifications (BUILD.md §8.12). */
  .notif-tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .notif-tabs a { padding: 8px 16px; border-radius: 100px; font-size: 13px; font-weight: 600; text-decoration: none; color: var(--ink-2); border: 1px solid var(--line); }
  .notif-tabs a.active { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .notif-advisory { background: rgba(34,197,94,.10); border: 1px solid rgba(34,197,94,.35); color: var(--ink-2); border-radius: var(--radius-lg); padding: 14px 18px; margin-bottom: 20px; font-size: 13px; line-height: 1.5; }
  .notif-advisory b { color: var(--green); }
  .notif-recipient-count { font-size: 13px; color: var(--ink-3); margin-top: 6px; }
  .notif-counter { font-size: 12px; color: var(--ink-3); text-align: end; margin-top: 4px; }
  .notif-counter.over { color: var(--red); }
  .notif-history { margin-top: 28px; }
  .notif-job { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .notif-job:last-child { border-bottom: none; }
  .notif-job .msg { color: var(--ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notif-job .meta { color: var(--ink-3); white-space: nowrap; }
  .notif-job .status-pill { font-size: 11px; padding: 3px 10px; border-radius: 100px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  .notif-job .status-pill.queued { background: rgba(148,163,184,.14); color: var(--ink-3); }
  .notif-job .status-pill.sending { background: rgba(242,140,56,.14); color: var(--accent-light); }
  .notif-job .status-pill.sent { background: rgba(34,197,94,.14); color: var(--green); }
  /* Expiry pill (sub-project 9, "ephemeral notifications") — whether this broadcast's message is still showing on recipients' passes. */
  .notif-job .status-pill.active { background: rgba(34,197,94,.14); color: var(--green); }
  .notif-job .status-pill.expired { background: rgba(148,163,184,.14); color: var(--ink-3); }
  .automated-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
  .automated-card { background: var(--sunk); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 18px; }
  .automated-card h3 { margin: 0 0 6px; font-size: 15px; color: var(--ink); display: flex; align-items: center; gap: 8px; }
  .automated-card p { margin: 0; font-size: 13px; color: var(--ink-3); line-height: 1.5; }
  .automated-card .status-pill { font-size: 10px; padding: 3px 9px; border-radius: 100px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .automated-card .status-pill.live { background: rgba(34,197,94,.14); color: var(--green); }
  .automated-card .status-pill.pending { background: rgba(148,163,184,.14); color: var(--ink-3); }
`;

export function layout(title: string, bodyHtml: string, active?: NavKey, lang: Lang = 'en'): string {
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · LoyaNexa</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&display=swap">
<style>
${CHROME_CSS}
${PAGE_CSS}
</style>
</head>
<body>
${navBar(active, lang)}
<main>
${bodyHtml}
</main>
${tabBar(active, lang)}
</body>
</html>`;
}
