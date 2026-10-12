---
name: FinFlow
description: Dark institutional finance workspace with visible evidence and deliberate decisions.
colors:
  background: "#101416"
  card: "#181d20"
  card-hover: "#20272b"
  border: "#343d43"
  foreground: "#eef2f4"
  muted: "#a4afb7"
  accent: "#d3e6bd"
  accent-strong: "#b9d49c"
  on-accent: "#172015"
  warning: "#ebc17b"
  error: "#ff9e9e"
  running: "#9ac4ef"
typography:
  display:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "clamp(48px, 6.2vw, 88px)"
    fontWeight: 450
    lineHeight: 1.02
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "clamp(32px, 4vw, 52px)"
    fontWeight: 450
    lineHeight: 1.13
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 550
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    fontFeature: '"tnum" 1'
  status:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  control: "6px"
  panel: "12px"
  pill: "calc(infinity * 1px)"
spacing:
  unit: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "48px"
components:
  button-default:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-default-hover:
    backgroundColor: "{colors.border}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-destructive:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  cta:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "12px 22px"
  cta-hover:
    backgroundColor: "{colors.accent-strong}"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
    padding: "16px"
  navigation-active:
    backgroundColor: "{colors.card-hover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  badge-warning:
    backgroundColor: "color-mix(in oklab, #ebc17b 15%, transparent)"
    textColor: "{colors.warning}"
    typography: "{typography.status}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
---

# Design System: FinFlow

## Overview

**Creative North Star: "Dark institutional"**

The user-selected dark institutional direction is expressed through graphite surfaces, cool white Geist typography, fine rules, and financial figures with stable alignment. The system feels restrained and precise: generous public headings lead into denser working records, settings, and review controls.

Visual emphasis belongs to the next action and the state of the work. Sage identifies primary actions and positive outcomes; amber asks for review. A broad sage section is also present on the public page, so restraint describes the hierarchy rather than an arbitrary limit on accent coverage. Source evidence and human decisions remain visible, as required by PRODUCT.md.

**Key Characteristics:**
- Graphite layers with fine separators and minimal ambient depth.
- Geist for prose and controls; Geist Mono for financial data and compact status.
- Clear state colors paired with text and, where used, vector icons.
- Dense records in bounded panels; responsive stacking with local table scrolling.

This is a scan of the implemented redesign, reconciled with the provisional system. The authority is the user's selected direction and the source code; the earlier seed is unverified. Sources: `app/globals.css`, `app/layout.tsx`, the public page and workpaper, the shared UI primitives, `AppNavigation`, and sampled settings/workflow components. Existing desktop and mobile captures in `.impeccable/review` corroborate the composition. Component previews in `.impeccable/design.json` expand the current source styles and do not add a new component API.

## Colors

The palette places pale, cool type on graphite, with sage actions and clear functional status colors. Frontmatter records the screen palette; source CSS remains the implementation authority.

### Primary
- **Sage** (`accent`): primary actions, selected sample tabs, focus, and positive results; also the public controls section's background.
- **Deep Sage** (`accent-strong`): the public call-to-action hover fill. Shared accent buttons instead reduce opacity on hover.
- **Ink on Sage** (`on-accent`): text on sage, warning, and destructive button fills.

### Secondary
- **Review Amber** (`warning`): exceptions, authorization gates, and revision actions.
- **Error Rose** (`error`): failed states, rejections, and destructive actions.
- **Running Blue** (`running`): workflow progress and running-step emphasis.

### Neutral
- **Graphite Ground** (`background`): page canvas and recessed fields.
- **Graphite Surface** (`card`): navigation, panels, workpapers, and dialogs.
- **Graphite Hover** (`card-hover`): active navigation and interactive surface emphasis.
- **Slate Rule** (`border`): dividers, field outlines, and card boundaries.
- **Cool White** (`foreground`): primary type and content.
- **Cool Gray** (`muted`): supporting copy, metadata, and inactive navigation.

**The Semantic Color Rule.** Use the existing color roles for state and emphasis. Pair warning, error, running, and completion colors with readable state text; color is not the only signal.

Status badges use translucent versions of the same roles, not a separate pastel palette. Print styles in `app/globals.css` switch to white paper and dark text; do not apply the screen palette to printed report output.

## Typography

**Display Font:** Geist, with the source's system-ui/sans-serif fallback.
**Body Font:** Geist, loaded by Next's font integration.
**Label/Mono Font:** Geist Mono for compact badges, financial figures, and identifiers; ordinary form labels remain Geist.

**Character:** Tight, balanced headings create the public hierarchy. Working screens favor legible, compact prose and aligned numbers; mono type is functional rather than the voice for all copy.

### Hierarchy
- **Display:** the fluid public hero role in frontmatter. It uses regular variable weight and tight tracking, with the second line muted.
- **Headline:** the public section-heading role. Other public closing and control headings use nearby fluid sizes defined in the stylesheet rather than a second global type system.
- **Title:** workspace page-heading role; use it where the page-title class is present rather than assuming all current headings already share it.
- **Body:** shared component prose and table text. The public introduction is larger and more open; evidence detail uses compact prose.
- **Label:** medium-weight form labels and shared button text.
- **Data / Status:** distinct mono roles for the sample's monetary figures and the shared badges. Tables use tabular numerals globally.

**The Financial Alignment Rule.** Keep financial columns tabular. Use Geist Mono for monetary figures and technical identifiers, while keeping explanatory prose in Geist.

Headings balance their wrapping, paragraphs use pretty wrapping, and the public copy is bounded by component-specific widths. Isolated smaller metadata styles are not promoted into the reusable hierarchy.

## Layout

The main content cap is (1240px). The public wrapper has (48px) side gutters on wide screens, (24px) at the (900px) breakpoint, and (20px) at (640px). The workspace page container uses (40px 36px 64px) padding, changing to (28px 20px 48px) on narrow screens. Spacing is primarily built from the (4px) rhythm in the source, with optical exceptions in individual components.

Desktop workspace navigation occupies (224px) and becomes a labeled menu below Tailwind's `md` breakpoint (768px). The mobile bar is (64px) high. Active links remain distinguishable by surface and text, and route selection closes the menu.

The public workpaper pairs a flexible table with a (310px) evidence column. At (900px), evidence moves below the table. At (640px), the table retains a (470px) minimum width inside a local scroll area, with a visible scroll instruction. Public workflow rows, the control section, and authentication columns stack on small screens. These are observed layout behaviors; the landing page's particular section sequence belongs in its surface brief, not in every future page.

## Elevation & Depth

Depth comes mainly from adjacent graphite tones, fine borders, and translucent semantic fills. Ordinary cards remain flat. The native modal dialog has the one explicit diffuse shadow and a dark backdrop.

### Shadow Vocabulary
- **Dialog:** `var(--shadow-dialog)`; the exact value is (0 24px 80px rgb(0 0 0 / 35%)). The backdrop is black at (70%) opacity.
- **Selected tab:** a (1px) accent underline implemented as a box shadow. It signals selection rather than surface elevation.
- **Focus:** the global outline is (2px) with a (4px) offset; shared buttons and form fields use a (2px) accent ring instead.

**The Tonal Surface Rule.** Separate ordinary surfaces with graphite tones and fine borders. Reserve the documented diffuse shadow for modal dialogs.

Color transitions are short and local. Public links and calls to action use (0.2s); workflow step changes use a (0.25s) ease-out fade with a small vertical movement. Spinners and running indicators convey active work. Reduced-motion CSS removes smooth scrolling and reduces animation/transition durations to (0.01ms).

## Shapes

Controls use the small control radius; panels, workpapers, and dialogs use the larger panel radius. Badges are pill-shaped, while data rows are separated by straight rules. Fine (1px) borders provide structure. Avoid deriving a universal pill-button treatment from the status badge.

The FinFlow mark is built from three descending, slanted bars in the current text color; preserve the existing `Brand` component instead of substituting a glyph or unrelated finance symbol.

## Components

### Buttons

Compact, explicit actions with restrained emphasis.
- **Shape and size:** control radius, a default minimum height of (44px), compact minimum of (36px), large minimum of (48px), and square icon controls of (44px).
- **Default:** card fill, foreground text, and a border; hover uses the border color as fill.
- **Primary:** the shared `accent` variant uses sage with ink text. Warning and destructive variants use their semantic fills with the same ink text. All three use (90%) opacity on hover.
- **Outline / Ghost:** transparent at rest, card fill on hover; only outline carries a border.
- **Focus / Disabled:** a visible accent ring; disabled controls reject pointer interaction and use (50%) opacity.
- **Public CTA:** a separate anchor pattern with a minimum height of (48px), (20px) icon gap, and weight (550); it darkens to `accent-strong` on hover. Do not erase this distinction when using the shared button.

### Chips

Compact mono labels for status, not decorative category pills. The shared badge has a fine border, pill silhouette, and the frontmatter's status typography. Accent, warning, error, and running variants use their role at (15%) background opacity with full-color text and a transparent border. Default and muted variants use the card surface and border. These badges have no invented hover behavior.

### Cards / Containers

Flat, bounded working surfaces. The card primitive carries panel corners, a fine border, and the card surface. Header, content, and footer use (16px) padding, with content/footer top padding removed to avoid double spacing. Workpapers are a denser signature container with a shared table/evidence boundary and a footer for record flow.

### Inputs / Fields

Outlined fields with the control radius, foreground text, muted placeholders, and an accent caret. Settings forms reuse an inline input pattern: transparent fill, fine border, and the documented input padding. There is currently no separate `components/ui/input.tsx` component. The shared textarea uses the page background and a minimum height of (80px). Labels are visibly associated with fields; secret and model identifier inputs may use mono type. Focus uses the accent ring. The textarea reduces disabled opacity and shows a not-allowed cursor. Error messages use the error role and readable text.

### Navigation

Desktop workspace links use (13px) Geist text, (17px) vector icons, a minimum height of (44px), and control corners. Inactive links are muted; active links use the hover surface and foreground text. Mobile navigation has an explicit menu control, expanded state, and Escape dismissal. Public navigation is a slim ruled row with muted links that brighten on hover; only sign-in remains in its narrow layout.

### Dialogs

Native modal dialogs use the card surface, panel corners, (24px) padding, and the documented shadow. Their width is capped at (512px), with (16px) side clearance and a maximum height of the dynamic viewport minus (48px). Content scrolls when necessary. Native modal focus containment, Escape handling, background-click dismissal, and focus restoration are part of the implemented behavior.

### Sample Workpaper

A table and its evidence panel form one record-reading surface. Keyboard-accessible tabs switch all sample content together; arrow keys, Home, and End move selection. The active tab uses sage text and an underline. The evidence panel announces updates politely. Financial amounts use mono type, review rows use a faint amber fill, and every scenario retains its illustrative-data label. This component is public sample evidence, not a source of production performance claims.

## Do's and Don'ts

### Do:
- **Do** use semantic roles from app/globals.css and the normative tokens above.
- **Do** keep amounts tabular and retain visible source references beside the result they explain.
- **Do** keep visible focus, associated field labels, textual states, and keyboard access to sample tabs.
- **Do** let narrow layouts stack and scroll wide tables within their own panels.
- **Do** label sample financial records as illustrative.

### Don't:
- **Don't** add decorative gradients, chat sparkle motifs, or generated illustrations to this institutional world.
- **Don't** use invented customer logos, artificial performance metrics, or unsubstantiated certification claims as visual credibility.
- **Don't** turn every panel into a floating card with a shadow.
- **Don't** treat an authorization action as evidence of payment execution.
