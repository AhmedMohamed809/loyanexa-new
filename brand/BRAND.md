# LoyaNexa — brand tokens

Extracted directly from the supplied logo file.

| Token | Light | Dark | Use |
|---|---|---|---|
| Navy (primary) | `#203757` | `#51637C` | Buttons, cards, CTA, headings |
| Orange (accent) | `#F96400` | `#FA802E` | Stamp dots, numbers, highlights — used sparingly |
| Canvas | `#F9FAFB` | `#070C14` | Page background |
| Paper | `#FFFFFF` | `#0B121C` | Cards and panels |
| Sunk | `#F3F4F6` | `#0E1826` | Alternating section bands |
| Ink | `#1A2C46` | `#EDF1F6` | Body text |
| Ink-2 | `#4A5A70` | `#A9B4C2` | Secondary text |
| Ink-3 | `#8794A5` | `#76839A` | Labels, captions |
| Line | `#E5E8EC` | `#162334` | Hairlines |

## Logo files
- `loyanexa-logo.png` — 1485×302, transparent, for light backgrounds
- `loyanexa-logo-dark.png` — same, navy strokes lifted to `#E9EEF5` for dark mode

Both are cropped from the original and have the white field removed, so they sit on
any background. The site swaps between them via the `--logo` CSS variable, so dark mode
needs no extra markup.

## Rules
- **Orange is an accent, not a surface.** It carries the stamp marks, figures and one
  highlight per section. Filling large areas with it makes the page shout.
- Navy does the structural work: buttons, the loyalty card, the closing CTA.
- Never place orange text on navy at body size — the contrast is too low. Use white.
