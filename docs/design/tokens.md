# Design tokens

The values live in [`tokens.css`](tokens.css); this file explains them. `apps/web` imports `tokens.css`
and maps the variables into Tailwind 4 with `@theme inline` (for example `--color-background: var(--background)`).
Components use the Tailwind names (`bg-card`, `text-muted-foreground`, `text-status-held-fg`) and never
raw hex.

## Direction in one line

A working ledger for someone under deadline: warm paper surfaces, ink-navy actions, tabular figures, and
one distinct colour (violet) reserved for "held for information". Nothing decorative competes with the
money, the status and the evidence.

## Colour

### Roles

| Token | Role | Light | Dark |
|---|---|---|---|
| `--background` | Page | `#fbfaf7` | `#12151a` |
| `--foreground` | Body text | `#1c1f24` | `#e7e9ec` |
| `--card` / `--card-foreground` | Cards, table surface | `#ffffff` / `#1c1f24` | `#1a1e24` / `#e7e9ec` |
| `--popover` / `--popover-foreground` | Dialogs, tooltips, menus | `#ffffff` / `#1c1f24` | `#1f242b` / `#e7e9ec` |
| `--primary` / `--primary-foreground` | The one primary action per view; links | `#1f3a5f` / `#ffffff` | `#8fb4e3` / `#0e1a2b` |
| `--secondary` / `--secondary-foreground` | Secondary buttons | `#eeece6` / `#1c1f24` | `#262b33` / `#e7e9ec` |
| `--muted` / `--muted-foreground` | Quiet panels (source snippets), meta text | `#f1efea` / `#585d66` | `#20252c` / `#a3a9b2` |
| `--accent` / `--accent-foreground` | Selected row, active nav item, highlighted citation | `#e6ecf3` / `#1f3a5f` | `#23324a` / `#d7e4f5` |
| `--destructive` / `--destructive-foreground` | Reject, irreversible actions, error text | `#b3261e` / `#ffffff` | `#f08a7e` / `#2a0a06` |
| `--border` | Boundaries that identify a control or a card (3:1) | `#868b94` | `#737a85` |
| `--input` | Text field and checkbox outlines (3:1) | `#767b84` | `#808792` |
| `--ring` | shadcn focus ring | `#1f5fa8` | `#7fb0ec` |
| `--focus-ring` | Carnet focus outline (same value as `--ring`, kept separate so it can diverge) | `#1f5fa8` | `#7fb0ec` |
| `--divider` | Decorative hairlines between table rows and sections only | `#e2dfd8` | `#2c323b` |

`--divider` is deliberately below 3:1: it separates rows that are already separated by text and spacing,
and WCAG 1.4.11 does not apply to it. It must never be the only visible edge of an input, a button or a
card that is a control. Those use `--border` or `--input`.

### Status tones

Six tones, each a foreground (`-fg`, used for the icon and the label) and a background (`-bg`, the badge
fill). They are chosen so that the pairs most likely to be confused (progress vs held, success vs
warning, warning vs danger) differ in lightness as well as hue, and every badge also carries a distinct
icon and a text label. Colour is the third signal, never the first.

| Tone | Meaning in Carnet | Icon (lucide) | Light fg / bg | Dark fg / bg |
|---|---|---|---|---|
| `neutral` | Not started, recalled, cancelled without a failure, unknown | `circle-dashed` | `#3f4650` / `#eceef1` | `#c9ced6` / `#262b33` |
| `progress` | Scheduled, processing, sent (not final), waiting for Airwallex | `loader-circle` (static), `send` for SENT | `#1a4f8b` / `#e3edf8` | `#9cc4f2` / `#16263b` |
| `success` | Paid, answer submitted, action done, evidence strong | `circle-check` | `#1d6b4f` / `#e2f2ea` | `#7fd3ae` / `#12291f` |
| `warning` | Overdue, weak evidence, needs owner, stale data | `triangle-alert` | `#7f4500` / `#fcefd9` | `#f2c46b` / `#2e2210` |
| `danger` | Failed, cancelled with a failure, approval rejected or blocked, verifier rejection | `octagon-x` | `#a1261b` / `#fbe6e3` | `#f4a097` / `#33171a` |
| `held` | Held for information (an open Transaction RFI on this transfer) | `circle-pause` | `#5b2d91` / `#efe7f8` | `#c9a8f0` / `#261a38` |

Checked mentally against deuteranopia, protanopia and tritanopia simulations: the tones remain separable
by lightness at badge size, and the icon and label carry the meaning regardless. The `ui-reviewer`
should still check a grayscale screenshot of the queue.

### Contrast pairs (machine-read)

`scripts/design-contrast.ts` parses this block and `tokens.css` and fails if any pair is below its
threshold in light or dark. `body` = 4.5:1, `large` and `ui` = 3:1.

```contrast-pairs
--foreground --background body
--foreground --card body
--foreground --popover body
--foreground --muted body
--foreground --secondary body
--card-foreground --card body
--popover-foreground --popover body
--muted-foreground --background body
--muted-foreground --card body
--muted-foreground --muted body
--muted-foreground --secondary body
--primary-foreground --primary body
--secondary-foreground --secondary body
--accent-foreground --accent body
--destructive-foreground --destructive body
--primary --background body
--primary --card body
--destructive --background body
--destructive --card body
--status-neutral-fg --status-neutral-bg body
--status-neutral-fg --background body
--status-neutral-fg --card body
--status-progress-fg --status-progress-bg body
--status-progress-fg --background body
--status-progress-fg --card body
--status-success-fg --status-success-bg body
--status-success-fg --background body
--status-success-fg --card body
--status-warning-fg --status-warning-bg body
--status-warning-fg --background body
--status-warning-fg --card body
--status-danger-fg --status-danger-bg body
--status-danger-fg --background body
--status-danger-fg --card body
--status-held-fg --status-held-bg body
--status-held-fg --background body
--status-held-fg --card body
--ring --background ui
--ring --card ui
--focus-ring --background ui
--focus-ring --card ui
--border --background ui
--border --card ui
--input --background ui
--input --card ui
--focus-ring --muted ui
--focus-ring --popover ui
```

### Computed ratios

WCAG 2.x relative-luminance formula, values truncated (not rounded) to two decimals, computed on
4 Nov 2026 from the hex values in `tokens.css`. Every pair passes in both themes; the lowest margins are
`--border` (3.27:1 light on background) and `--status-success-fg` on its own background (5.54:1 light).

| Foreground | Background | Kind | Needs | Light | Dark |
|---|---|---|---|---|---|
| `--foreground` | `--background` | body | 4.5:1 | 15.83:1 | 15.04:1 |
| `--foreground` | `--card` | body | 4.5:1 | 16.52:1 | 13.75:1 |
| `--foreground` | `--popover` | body | 4.5:1 | 16.52:1 | 12.83:1 |
| `--foreground` | `--muted` | body | 4.5:1 | 14.38:1 | 12.67:1 |
| `--foreground` | `--secondary` | body | 4.5:1 | 13.98:1 | 11.69:1 |
| `--card-foreground` | `--card` | body | 4.5:1 | 16.52:1 | 13.75:1 |
| `--popover-foreground` | `--popover` | body | 4.5:1 | 16.52:1 | 12.83:1 |
| `--muted-foreground` | `--background` | body | 4.5:1 | 6.34:1 | 7.73:1 |
| `--muted-foreground` | `--card` | body | 4.5:1 | 6.61:1 | 7.07:1 |
| `--muted-foreground` | `--muted` | body | 4.5:1 | 5.76:1 | 6.51:1 |
| `--muted-foreground` | `--secondary` | body | 4.5:1 | 5.60:1 | 6.01:1 |
| `--primary-foreground` | `--primary` | body | 4.5:1 | 11.48:1 | 8.16:1 |
| `--secondary-foreground` | `--secondary` | body | 4.5:1 | 13.98:1 | 11.69:1 |
| `--accent-foreground` | `--accent` | body | 4.5:1 | 9.65:1 | 10.02:1 |
| `--destructive-foreground` | `--destructive` | body | 4.5:1 | 6.53:1 | 7.55:1 |
| `--primary` | `--background` | body | 4.5:1 | 11.00:1 | 8.54:1 |
| `--primary` | `--card` | body | 4.5:1 | 11.48:1 | 7.81:1 |
| `--destructive` | `--background` | body | 4.5:1 | 6.26:1 | 7.52:1 |
| `--destructive` | `--card` | body | 4.5:1 | 6.53:1 | 6.88:1 |
| `--status-neutral-fg` | `--status-neutral-bg` | body | 4.5:1 | 8.19:1 | 9.00:1 |
| `--status-neutral-fg` | `--background` | body | 4.5:1 | 9.13:1 | 11.57:1 |
| `--status-neutral-fg` | `--card` | body | 4.5:1 | 9.53:1 | 10.58:1 |
| `--status-progress-fg` | `--status-progress-bg` | body | 4.5:1 | 6.99:1 | 8.43:1 |
| `--status-progress-fg` | `--background` | body | 4.5:1 | 7.93:1 | 10.09:1 |
| `--status-progress-fg` | `--card` | body | 4.5:1 | 8.28:1 | 9.23:1 |
| `--status-success-fg` | `--status-success-bg` | body | 4.5:1 | 5.54:1 | 8.68:1 |
| `--status-success-fg` | `--background` | body | 4.5:1 | 6.15:1 | 10.30:1 |
| `--status-success-fg` | `--card` | body | 4.5:1 | 6.42:1 | 9.42:1 |
| `--status-warning-fg` | `--status-warning-bg` | body | 4.5:1 | 6.71:1 | 9.52:1 |
| `--status-warning-fg` | `--background` | body | 4.5:1 | 7.30:1 | 11.22:1 |
| `--status-warning-fg` | `--card` | body | 4.5:1 | 7.62:1 | 10.26:1 |
| `--status-danger-fg` | `--status-danger-bg` | body | 4.5:1 | 6.24:1 | 8.07:1 |
| `--status-danger-fg` | `--background` | body | 4.5:1 | 7.16:1 | 8.99:1 |
| `--status-danger-fg` | `--card` | body | 4.5:1 | 7.47:1 | 8.22:1 |
| `--status-held-fg` | `--status-held-bg` | body | 4.5:1 | 7.83:1 | 8.03:1 |
| `--status-held-fg` | `--background` | body | 4.5:1 | 9.02:1 | 9.01:1 |
| `--status-held-fg` | `--card` | body | 4.5:1 | 9.42:1 | 8.24:1 |
| `--ring` | `--background` | ui | 3:1 | 6.17:1 | 8.12:1 |
| `--ring` | `--card` | ui | 3:1 | 6.44:1 | 7.42:1 |
| `--focus-ring` | `--background` | ui | 3:1 | 6.17:1 | 8.12:1 |
| `--focus-ring` | `--card` | ui | 3:1 | 6.44:1 | 7.42:1 |
| `--border` | `--background` | ui | 3:1 | 3.27:1 | 4.22:1 |
| `--border` | `--card` | ui | 3:1 | 3.42:1 | 3.86:1 |
| `--input` | `--background` | ui | 3:1 | 4.07:1 | 5.05:1 |
| `--input` | `--card` | ui | 3:1 | 4.25:1 | 4.61:1 |
| `--focus-ring` | `--muted` | ui | 3:1 | 5.60:1 | 6.84:1 |
| `--focus-ring` | `--popover` | ui | 3:1 | 6.44:1 | 6.92:1 |

Rules that follow from the table:
- Text on a status background uses that status's `-fg`, never `--foreground` mixed with a status fill.
- Disabled controls keep their label at `--muted-foreground` (passes 4.5:1); they are not faded with
  opacity, because the "pending" state of money buttons must stay readable.
- A new colour token is added to `tokens.css` and to the `contrast-pairs` block in the same change.

## Typography

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 13px | Badge and chip labels, table meta, timestamps. Never body copy. |
| `--text-sm` | 14px | Table cells, dense lists, draft answer text on desktop |
| `--text-base` | 16px | Body, every form input (16px stops iOS zoom), draft answer text on mobile |
| `--text-lg` | 18px | Card and section titles |
| `--text-xl` | 22px | Screen title below 768px |
| `--text-2xl` | 28px | Screen title from 768px; the hero amount on the hold screen |

- Families: IBM Plex Sans for text, IBM Plex Mono for identifiers (RFI ids, request ids, hashes,
  IBAN fragments). Loaded through `next/font` (self-hosted, no third-party request), subsets `latin` and
  `latin-ext` so German counterparty names (Rheinblick Druck GmbH, Nordlicht, Altstadt) and the `ß`,
  `ä`, `ö`, `ü` render in the brand face. `display: swap` with `adjustFontFallback` so the fallback has
  matching metrics (no CLS).
- The fallback stack ends in Noto Sans SC / PingFang SC / Microsoft YaHei: Airwallex questions carry a
  `zh` title. Carnet shows `en`, but if the `en` text is missing it shows `zh` rather than an empty row,
  and it must render, not show tofu.
- Money and every column of figures use `font-variant-numeric: tabular-nums lining-nums` (Tailwind
  `tabular-nums`). Amounts are right-aligned in tables.
- Weights: 400 body, 500 labels and table headers, 600 titles and amounts. No 700+; no italics for
  meaning.
- Line height 1.5 for body, 1.25 for titles. Measure: draft answer paragraphs max 68ch.
- Uppercase only for the small section eyebrow labels (with `--tracking-caps`); statuses are sentence
  case ("Held for information"), not shouted.

## Spacing and layout

4px base: `--space-1` (4) to `--space-16` (64). Rhythm: 8 inside components, 16 between related
items, 24 between sections, 32 to 48 between page regions.

| Breakpoint | Width | Grid |
|---|---|---|
| mobile | 375 (min supported 320) | 1 column, 16px gutters, bottom-fixed action bars |
| tablet | 768 | 1 column content + collapsible nav (icon rail 64px) |
| desktop | 1440 | nav 216px (`--shell-nav-width`) + content up to `--content-max` (1312px), 2-column hold layout |

Tailwind breakpoints used: `md` = 768px, `xl` = 1280px. Layouts are specified at 375 / 768 / 1440 in
each screen spec.

## Radius

`--radius` 6px for buttons, inputs and cards; `--radius-sm` 4px for badges and chips; `--radius-lg`
8px for dialogs; `--radius-full` only for the avatar and the live-dot. Square-ish corners suit a ledger.

## Elevation

| Token | Use |
|---|---|
| `--shadow-0` | Default: cards sit on the page with a `--border` edge, no shadow |
| `--shadow-1` | Sticky table header when scrolled |
| `--shadow-2` | Popovers, tooltips, the sticky ApprovalBar |
| `--shadow-3` | Dialogs (the bound approval dialog) |

Shadows never carry meaning; in dark theme they are nearly invisible, so the edge is always a border.
(Shadows are composite non-colour tokens and use `rgb()` with alpha; the hex-only rule applies to colour
tokens.)

## Motion

| Token | Value | Use |
|---|---|---|
| `--duration-instant` | 80ms | Button press, checkbox |
| `--duration-fast` | 140ms | Hover, tooltip in, badge tone change |
| `--duration-base` | 200ms | Dialog and sheet in, row highlight on a status change |
| `--duration-slow` | 320ms | The one-time "status changed" row highlight fade |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Entering and moving |
| `--ease-exit` | `cubic-bezier(0.3, 0, 1, 1)` | Leaving |

Rules:
- Motion explains a change (a status moved, a dialog opened); it never decorates. No parallax, no
  looping animation except the progress indicator inside a pending button and the "live" dot.
- Nothing animates layout size of content above the fold after first paint (CLS).
- **Reduced motion.** In `apps/web/src/app/globals.css` (not in `tokens.css`, which keeps its parse
  contract):

  ```css
  @media (prefers-reduced-motion: reduce) {
    :root { --duration-instant: 0ms; --duration-fast: 0ms; --duration-base: 0ms; --duration-slow: 0ms; }
    *, *::before, *::after { animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
  }
  ```

  Under reduced motion the pending spinner becomes a static `loader-circle` icon plus the text label
  (the label always carries the meaning), the live dot stops pulsing, and the status-change highlight
  becomes an instant tint that stays for 2 s.

## Theme

Light and dark follow `prefers-color-scheme`. `:root[data-theme="dark"]` exists so tests and screenshots
can force dark; there is no user toggle in M1 (a toggle would need a stored preference and a no-flash
script; add it only if a ticket asks).
