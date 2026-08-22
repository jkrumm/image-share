# @image-share/admin — Design

> Managed by basalt-ui (1.20.0). This is a **thin** instantiation — it records this
> app's **deltas only** on top of the shipped `basalt-*` rules. The universal law (earned color,
> neutral-by-default, three-tier `--vx-*` tokens, theme-is-data, the chart primitive contract, the
> elevation/density/shape doctrine) lives in those rules and the `/basalt:design` skill, and is
> **not** repeated here. Touch this file only to confirm identity, register the app's series, or
> record a genuine deviation.

## Precedence (when guidance conflicts)

This file's deltas win, then the shipped rules, then any skill:

1. **This file** (`@image-share/admin` DESIGN.md) — app-specific deltas. Highest authority.
2. **`basalt-*` rules** (`.claude/rules/basalt-*.md`) — the shipped law and its enforcement.
3. **Skills** (`/basalt:design`, `/basalt:charts`, `/frontend-design`, …) — generic method, lowest.

A skill never overrides this file or the `basalt-*` rules. When a skill's instinct collides with the
law, the law wins.

## Identity

@image-share/admin inherits the basalt-ui identity verbatim: modern zinc surfaces, one earned saturated
sky-blue accent, the `shadow-card` / `shadow-raised` / `shadow-overlay` depth split,
dense-by-default spacing, and the three-font system. The
law itself — every hex, role split, and enforcement rule — lives in the `basalt-tokens` and
`basalt-mantine` rules (`.claude/rules/basalt-{tokens,mantine}.md`) and `docs/DESIGN-SPEC.md` in
the basalt-ui repo; it is **not** restated here. Confirm or restate any intentional identity shift
below; **silence means "inherits the basalt-ui defaults unchanged."**

- **Accent hue:** blue (default: the saturated sky accent — `var(--vx-line)` neutral is
  still the default for single-series marks)
- **Tone deltas:** _(none — inherits)_

## Series dictionary

The framework owns the **roles** and the **available hues** (see the `basalt-tokens` rule). This
table is the app's **data dictionary** — which metric maps to which hue, as `{light,dark}` pairs,
wired through `defineSeries()`. This is the one design artifact that legitimately lives in the
consumer; keep it the single source of truth and never inline a hex elsewhere.

**None — this app ships no charts.** Every surface is Mantine chrome over image thumbnails; the
only colored ink is `StatCard tone` and the bare status hues on `Badge`/`Text`. Add `src/lib/series.ts`
and this table together, at the first chart.

Rules for this table (from the `basalt-tokens` / `basalt-charts` rules — do not relax):

- One hue per series, drawn from the identity families only. Never raw Material/AntD/Tailwind.
- A series earns a color only for **trend**, **signal/status**, or **categorical separation**.
  A lone single-series metric stays neutral (`var(--vx-line)`).
- Light is one shade **deeper**, dark one shade **lighter** — same hue, never the same hex.

## App deviations

Genuine, intentional departures from the basalt-ui defaults — each with a one-line justification. An
empty section is the correct default; do not invent deviations to fill it.

- **No icon set.** No icon library is installed, so every `SidebarItem`/mobile-bar slot is
  label-only and `EmptyState`/`route-error` are text-only. Deliberate — the admin is single-user
  and five destinations do not need glyphs. Supported since basalt-ui 1.20.0 floored `.tabIcon`:
  the mobile active pill is 48x28 with or without a glyph (it was a 24x4 dash on 1.19.1).
- **`basaltAppPlugin` with `manifest: false, icons: false`** (`vite.config.ts`) — head colors only.
  The admin is behind auth under `/admin`; it is not installable and ships no icon set.
- **`notifyMutation` over `notifyPromise`** (`features/common/notify.ts`) — `notifyPromise` takes a
  static `error` node and never sees the rejection, so every failure read the same generic line
  instead of the server's message. See `docs/design.md` §12.
