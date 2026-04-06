# Visual Style Guide — proton-bridge-mcp

This document captures the visual identity used for all icons and banners in this project. It exists so the icons, badges, and gradients can be recreated, extended, or restyled later without re-deriving the design.

The visual concept: **the official Proton Mail envelope glyph + an MCP "plug" mark**, expressing the bridge between Proton Mail and the Model Context Protocol. The plug is the chosen MCP metaphor because MCP literally plugs tools into models, and a plug silhouette stays recognizable at small sizes.

---

## 1. Color Palette

All purples are taken from the official Proton Mail palette plus two darker shades introduced for the MCP badge.

| Token | Hex | Used for |
|---|---|---|
| Lavender (lightest) | `#E3D9FF` | Highlight stop in `pm0` / `pm2` gradients |
| Purple light | `#AA8EFF` | End stop of `pm1` and `mcpGrad` |
| Proton purple | `#7341FF` | Mid stop in `pm0` / `pm2` |
| Proton purple (primary) | `#6D4AFF` | Primary brand purple, start of `pm1` and `mcpGrad`, end of `badgeGrad` |
| Deep purple | `#3A1F8A` | Start of `badgeGrad` (darker MCP badge) |
| Halo purple | `#1A0A4A` | Dark halo ring around the MCP badge |
| White | `#FFFFFF` | Plug glyph fill, legibility against any purple |

### Gradients

```xml
<!-- Proton Mail official glyph gradients (verbatim from official asset) -->
<linearGradient id="pm0" x1="13.509" y1="24.7672" x2="1.43523" y2="-17.1751" gradientUnits="userSpaceOnUse">
  <stop stop-color="#E3D9FF"/>
  <stop offset="1" stop-color="#7341FF"/>
</linearGradient>

<radialGradient id="pm1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse"
  gradientTransform="translate(30.7227 11.8138) scale(35.9848 33.9185)">
  <stop offset="0.5561" stop-color="#6D4AFF"/>
  <stop offset="0.9944" stop-color="#AA8EFF"/>
</radialGradient>

<linearGradient id="pm2" x1="47.6423" y1="50.957" x2="19.8702" y2="-8.95322" gradientUnits="userSpaceOnUse">
  <stop offset="0.271" stop-color="#E3D9FF"/>
  <stop offset="1" stop-color="#7341FF"/>
</linearGradient>

<!-- Light MCP gradient — used in logo.svg banner -->
<linearGradient id="mcpGrad" x1="0%" y1="0%" x2="100%" y2="100%">
  <stop offset="0%" stop-color="#6D4AFF"/>
  <stop offset="100%" stop-color="#AA8EFF"/>
</linearGradient>

<!-- Darker MCP badge gradient — used in icon.svg -->
<linearGradient id="badgeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
  <stop offset="0%" stop-color="#3A1F8A"/>
  <stop offset="100%" stop-color="#6D4AFF"/>
</linearGradient>
```

These IDs (`pm0`, `pm1`, `pm2`, `mcpGrad`, `badgeGrad`) are reused across files unchanged.

---

## 2. The Proton Mail Glyph

The envelope is the **official Proton Mail mark**, used verbatim. Three paths in a 36×36 coordinate space, filled with `pm0`, `pm1`, `pm2`. Never redraw it; copy these paths exactly.

```xml
<g><!-- transform varies by canvas -->
  <path fill-rule="evenodd" clip-rule="evenodd"
        d="M22.8601 13.464L22.8621 13.4656L12.8571 24.5714L0 10.4194V4.31488C0 3.61388 0.817029 3.23035 1.35631 3.67821L15.6207 15.5242C17.0001 16.6697 18.9999 16.6697 20.3793 15.5242L22.8601 13.464Z"
        fill="url(#pm0)"/>
  <path d="M28.2857 8.95834L22.8601 13.4641L22.8621 13.4657L15.6784 19.8113C14.4546 20.8923 12.6255 20.9196 11.3701 19.8755L0 10.4195V28.5617C0 30.6185 1.66735 32.2858 3.72414 32.2858H28.2857L30.8571 20.6221L28.2857 8.95834Z"
        fill="url(#pm1)"/>
  <path fill-rule="evenodd" clip-rule="evenodd"
        d="M28.2857 8.96285V32.2857L32.2758 32.2857C34.3326 32.2857 36 30.6182 36 28.5616V4.3149C36 3.6139 35.1829 3.23031 34.6437 3.67825L28.2857 8.96285Z"
        fill="url(#pm2)"/>
</g>
```

### Standard placements

| Canvas | Transform | Resulting glyph bbox |
|---|---|---|
| 64×64 (`icon.svg`) | `translate(2 4) scale(1.444)` | (2, 4) → (~54, ~56), ~52×52 |
| 16×16 (`small-icon.svg`) | `translate(0.5 1) scale(0.361)` | (0.5, 1) → (~13.5, ~14), ~13×13 |
| 720×220 (`logo.svg`) | `translate(50, 15) scale(5)` | upper-left of the banner |

The glyph is biased slightly upper-left in square icons to leave the lower-right corner free for the MCP overlay.

---

## 3. MCP Overlay — The Plug

The MCP element is a **bold electrical plug** silhouette. Two prongs, a chunky body, a small cable stub. This shape was chosen after rejecting:

- generic node graph (looked like "network", not MCP)
- chain links (looked like "chain", not "protocol")
- bare letter "M" (could mean anything)

### 3.1 Large variant — `icon.svg` (used at 64×64 and above)

A solid badge in the lower-right corner of the canvas. Three layers:

1. **Halo** — `#1A0A4A` rounded rect, 2 px larger than the badge body. Provides separation from the lavender envelope at all sizes through color contrast (a 1 px white halo did not survive downscale; the dark halo does).
2. **Badge body** — `url(#badgeGrad)` rounded rect (`#3A1F8A → #6D4AFF`).
3. **Plug** — solid white prongs, body, cable stub, vertically centered inside the badge.

```xml
<!-- Halo -->
<rect x="33.5" y="33.5" width="29" height="29" rx="7.5" fill="#1A0A4A"/>
<!-- Badge body -->
<rect x="35.5" y="35.5" width="25" height="25" rx="6" fill="url(#badgeGrad)"/>
<!-- Plug -->
<g fill="#ffffff">
  <rect x="42.3" y="37.9" width="3.3" height="5.5" rx="0.7"/>  <!-- prong L -->
  <rect x="50.3" y="37.9" width="3.3" height="5.5" rx="0.7"/>  <!-- prong R -->
  <rect x="39.2" y="42.7" width="17.6" height="12.1" rx="2.2"/><!-- body -->
  <rect x="46.35" y="54.8" width="3.3" height="3.3"/>          <!-- cable stub -->
</g>
```

Badge geometry: 25×25 body inside a 29×29 halo, both anchored at the lower-right with ~1.5 px padding from the canvas edge. Plug bbox is 17.6×17.2, vertically centered inside the badge.

### 3.2 Small variant — `small-icon.svg` (used at 16×16 and 32×32)

At 16 px the badge collapses into "purple chip with darker outline" and the plug detail disappears. The small variant therefore drops the badge entirely and overlays a **white plug only** directly on the envelope.

- Native viewBox is `0 0 16 16` (the 32×32 PNG is a 2× upscale of this same SVG).
- The plug is ~1.25× the "natural" small-canvas plug size — large enough to be recognizable, small enough not to swallow the envelope.
- Anchored in the lower-right of the canvas with ~0.5 px padding.

```xml
<g fill="#ffffff">
  <rect x="10" y="9" width="1.25" height="1.5" rx="0.25"/>     <!-- prong L -->
  <rect x="13.25" y="9" width="1.25" height="1.5" rx="0.25"/>  <!-- prong R -->
  <rect x="9" y="10.5" width="6.5" height="4" rx="0.8"/>       <!-- body -->
  <rect x="11.625" y="14.5" width="1.25" height="1"/>          <!-- cable stub -->
</g>
```

Plug bbox is 6.5×6.5 in 16-unit space (~40% of the canvas). Centered at (12.25, 12.25).

### 3.3 Plug proportions (constant across variants)

The plug shape follows fixed ratios so it can be re-rendered at any size:

| Part | Width | Height | Anchor |
|---|---|---|---|
| Body | 1.0 W | 0.62 W | base reference |
| Each prong | 0.19 W | 0.24 W | top of body, at 1/4 and 3/4 of body width |
| Gap above body for prongs | — | 0.24 W | prongs sit above the body |
| Cable stub | 0.19 W | 0.16 W | bottom-center of body |

Where `W` = body width. To draw the plug at a target size `S` (full plug bbox edge), set `W = S` (body = full width, height ≈ 1.02 × W including prongs and cable).

---

## 4. Composition Rules

| Rule | Why |
|---|---|
| Envelope is dominant; MCP element occupies the lower-right | Mail-app tradition; the MCP overlay is a "modifier", not the subject |
| At ≥64 px: badge with dark halo + dark gradient + white plug | Visible structure survives |
| At ≤32 px: drop the badge, keep only the white plug | Thin rings and small gradient differences disappear at small pixel counts |
| No text, no animations, no drop shadows in icons | None of these survive 16×16; `logo.svg` is the only place they're used |
| Background is always transparent | Lets the icon sit on any host UI |

---

## 5. The Horizontal Banner — `logo.svg`

`logo.svg` (720×220) is the only place where the project breaks the "icon" rules. It uses:

- The same Proton Mail glyph on the **left** at `scale(5)`
- A central **bridge** with two pillars, an arc, a road bar, and three animated dots representing data flowing between Proton and MCP
- A **square MCP node-graph badge** on the right with a central "MCP" text label, four cardinal endpoint dots, and four diagonal endpoint dots on a lighter `mcpGrad` background

Animations, drop shadow filter (`feDropShadow` in `#6D4AFF`), and the "MCP" wordmark are unique to the banner. **Do not port these into icons.**

---

## 6. Asset Inventory

| File | Canvas | Source | Purpose |
|---|---|---|---|
| `assets/logo.svg` | 720×220 | hand-built | Wide banner with envelope + bridge + MCP block |
| `assets/icon.svg` | 64×64 (`viewBox`) | this guide | Square master icon with full MCP badge |
| `assets/icon-256.png` | 256×256 | rendered from `icon.svg` | High-res / retina app icon, GitHub social card |
| `assets/icon-64.png` | 64×64 | rendered from `icon.svg` | App icon, MCPB package, etc. |
| `assets/small-icon.svg` | 16×16 (`viewBox`) | this guide | Square small-icon master, white plug only |
| `assets/icon-32.png` | 32×32 | rendered from `small-icon.svg` | Favicon / small-icon use |
| `assets/icon-16.png` | 16×16 | rendered from `small-icon.svg` | Favicon, taskbar |

**Important rendering rule:** PNGs at ≤32 px MUST be rendered from `small-icon.svg`, not from `icon.svg`. The two SVGs are intentionally different designs for different size ranges.

---

## 7. Rendering

Use `rsvg-convert` (libRSVG, installed via Homebrew). It correctly handles all gradients used here.

```bash
# Large icons (≥64 px) — render from icon.svg
rsvg-convert -w 256 -h 256 assets/icon.svg -o assets/icon-256.png
rsvg-convert -w 64 -h 64 assets/icon.svg -o assets/icon-64.png

# Small icons (≤32 px) — render from small-icon.svg
rsvg-convert -w 32 -h 32 assets/small-icon.svg -o assets/icon-32.png
rsvg-convert -w 16 -h 16 assets/small-icon.svg -o assets/icon-16.png
```

Never render `small-icon.svg` larger than 32 px — it visually misrepresents how it will be used.

---

## 8. Recreating Any Icon

Given this guide alone, the steps to recreate the suite are:

1. Define the seven palette tokens in §1.
2. Embed all five gradient defs from §1.
3. Place the Proton Mail glyph using the transform from §2 for the target canvas.
4. **For ≥64 px:** add the halo + badge body + plug from §3.1, anchored lower-right.
5. **For ≤32 px:** add the white plug from §3.2 directly on the envelope, anchored lower-right.
6. Render PNGs with `rsvg-convert` per §7, choosing the right master SVG for each size.
