---
name: learn-deck
description: Design custom HTML slide decks from a user's content and visual direction, then convert the browser-rendered slides into editable PPTX objects. Use for new PPT/PPTX generation, reference-image-driven presentation styling, or converting local HTML/URLs to editable PowerPoint while preserving separate text, shapes, gradients, and icons.
---

# LearnDeck

## Core Rule

For a new presentation, author the final slide HTML directly. Do not create a slide-plan JSON and do not choose from a fixed layout enum unless the user explicitly requests the legacy deterministic generator.

The default pipeline is:

`user content + visual direction -> model-designed HTML/CSS -> browser DOM audit -> editable PPTX -> final render QA`

Shared design tokens should make the deck coherent, but every slide's composition should follow its own message. Do not force all slides into repeated cover/content/steps/compare/summary templates.

## Quick Start

### Create a New PPT

1. Understand the audience, purpose, content hierarchy, and requested visual direction. If the user provides a reference image, inspect it and reuse its visual language without copying its composition blindly.
2. Write one self-contained HTML file. Use `templates/learn-deck-polished-style.html` as a converter-compatible style template when that visual direction fits the request.
3. Give every slide a `.slide` root and design its DOM/CSS directly around that slide's content.
4. Run the browser DOM preflight and fix every reported issue:

```bash
node /path/to/learn-deck/scripts/html_to_ppt.js \
  --input /path/to/deck.html \
  --dom-audit-only
```

5. Convert only after the DOM audit reports zero issues:

```bash
node /path/to/learn-deck/scripts/html_to_ppt.js \
  --input /path/to/deck.html \
  --out-dir /path/to/output \
  --name deck-name
```

This produces `<out-dir>/<name>-editable.pptx` and preserves the source HTML for revisions.

### Convert Existing HTML

Use the same command for a local HTML file or URL:

```bash
node /path/to/learn-deck/scripts/html_to_ppt.js \
  --input /path/to/source.html \
  --out-dir /path/to/output \
  --name deck-name
```

If Codex workspace dependencies are available, call `load_workspace_dependencies` first and run with the returned Node.js paths:

```bash
NODE_PATH="$NODE_MODULES:/Users/$USER/node_modules" "$NODE_BIN" \
  /path/to/learn-deck/scripts/html_to_ppt.js \
  --input /path/to/source.html \
  --out-dir /path/to/output \
  --name deck-name
```

## Direct HTML Workflow

### 1. Establish the Art Direction

- Derive the style from the user's words, audience, brand, and references. Do not reduce the choice to a fixed list of named themes.
- Define a small set of CSS variables for the palette, type scale, spacing, borders, radii, and shadows.
- Match reference images by visual grammar: density, whitespace, hierarchy, color behavior, geometry, and motif. Adapt the layout to the new content.
- If style is unspecified, infer a suitable direction. Ask one short question only when the missing choice would materially change the result.

### 2. Design the Narrative and Each Slide

- Give each slide one clear communication goal.
- Split content instead of shrinking text or overcrowding a page.
- Choose each composition from the content itself: a strong statement, diagram, comparison, timeline, data story, annotated visual, card system, or another bespoke arrangement.
- Vary composition and scale across the deck while keeping shared tokens consistent.
- Avoid repeating the same grid on consecutive slides unless repetition is meaningful.

### Style Template Contract

- A style template defines visual grammar only: palette relationships, typography, spacing rhythm, corner radii, border treatment, shadows, and decorative motifs.
- The user's content determines the narrative, slide count, DOM structure, composition, number of cards, charts, diagrams, and visual emphasis.
- Never copy the template's sample text into a customer deck.
- Never force new content into the template's existing boxes or preserve its card count when the content calls for another composition.
- It is acceptable to resize, remove, add, or rearrange components while retaining the same visual family.
- Use `templates/learn-deck-polished-style.html` for the polished light aesthetic shown in the bundled showcase. Treat its seven slides as a composition library, not a required sequence or fixed page set. Select and reshape only the specimens that fit the user's content.

### 3. Author Converter-Compatible HTML

- Use a fixed `1280px × 720px` canvas for every `.slide` by default.
- Make the HTML self-contained. Prefer local/system fonts, CSS shapes, and inline SVG.
- Use normal DOM elements for every object that should remain independently editable.
- Keep intended text boxes as semantic text elements such as `h1`, `h2`, `p`, `li`, or `span`.
- Flexbox, grid, and absolute positioning are all acceptable; browser coordinates are authoritative.
- Use simple backgrounds, borders, rounded rectangles, ellipses, linear gradients, restrained shadows, and inline SVG icons.
- Do not use canvas, video, CSS filters, masks, blend modes, or transform-based rotation for content that must survive as editable PPT objects.
- The current converter does not rebuild `<img>` elements or CSS `url(...)` backgrounds. Use inline SVG/CSS visuals, or extend the converter before relying on raster images.
- Do not use a large radial gradient as the primary slide background. The converter approximates it as a literal editable ellipse, which creates an awkward object boundary in PowerPoint. Prefer a full-canvas two-color linear-gradient rectangle for a soft atmospheric background.
- Treat PowerPoint selection ergonomics as part of the design. Large background objects should either match the full slide bounds or stay as small corner accents; do not place a giant selectable decorative shape behind the title or body copy.
- Keep optional decorative shapes visually quiet and below roughly one quarter of the slide area. They must not compete with the main message or create misleading selection boxes during editing.

### 4. Mandatory Layout Safety Checks

- Set a content budget before fixing a card or panel height. Test the longest real title and body copy, including CJK text where relevant.
- No text may cross a card, panel, footer, or slide boundary. Preserve at least `10px` of visible bottom padding inside compact cards.
- If content does not fit, shorten the copy, enlarge the container, or redesign the composition. Do not hide overflow and do not solve it by making important text illegibly small.
- Use inline SVG with an explicit `viewBox` for small icons. Do not use Unicode symbols, emoji, or font glyphs such as `□` or `◇` inside icon containers; their metrics shift across Chrome, PowerPoint, and LibreOffice. Plain arrows are acceptable only as inline text separators when exact icon centering is not required.
- Center icon artwork with explicit dimensions and `display: flex; align-items: center; justify-content: center`. Keep the SVG smaller than its colored container so it has even internal padding.
- Reserve separate layout slots for controls, logos, labels, titles, and page markers. Use grid or flex columns with an explicit gap of at least `8px`; never separate independent objects with repeated spaces, `&nbsp;`, transparent text, or negative margins.
- For window-like chrome, keep the control-dot cluster and the window title in separate sibling elements. The title must start after the full control cluster plus the safety gap.
- Add `data-layout-guard="no-overlap"` to critical rows whose direct children must never intersect. Add `data-layout-guard="contain"` to cards and panels whose direct children must remain inside their bounds. Combine them as `data-layout-guard="contain no-overlap"` when both rules apply.
- Add `text-contain` to circles, pills, compact cards, and other text-bearing shapes whose text must remain inside the padded content area. Ellipse-like shapes receive an additional shape-aware text check.
- Add `single-line` to titles, labels, chips, and chart annotations that must never wrap. Do not add it to intentionally multiline copy.
- Add `text-center` to short labels that must be geometrically centered inside a circle, pill, or compact card.
- Add `icon-center` to an icon container that must contain exactly one centered inline SVG.
- Add `chart-labels` to a chart-series container. Mark each direct series child with `data-chart-series` and its visible label with `data-chart-label`.
- Use `data-layout-allow-overflow` only for an intentional decorative element that extends past the slide edge. Never use it for text, charts, cards, or content. Do not add `data-layout-ignore` merely to silence an audit failure.
- The converter treats layout-guard failures as blocking errors. Fix the HTML structure or spacing; do not remove the guard merely to make conversion pass.
- Run `--dom-audit-only` after every meaningful HTML revision. It checks slide overflow and text overflow automatically, then enforces the declared overlap, containment, wrapping, centering, icon, and chart-label contracts in Chromium without generating screenshots.
- Browser success is not enough: PowerPoint font metrics can change wrapping and baseline positions. Render the converted PPTX and inspect every slide at full size.
- The final QA pass must have zero unintended text overflow, clipping, overlap, icon drift, unexpected wrapping, or objects crossing neighboring cards. Fix the HTML and reconvert until clean.

### 5. Mandatory Browser DOM Preflight

1. Run `scripts/html_to_ppt.js --input <deck.html> --dom-audit-only` before creating the PPTX.
2. Read every reported slide number, issue type, element label, edge, box, wrap count, center drift, or missing chart label.
3. Fix the original HTML and rerun the preflight until `domAudit.issues` is `0`.
4. Do not convert a deck that fails preflight, and do not remove guards or add overflow exceptions simply to make the command pass.

The DOM preflight replaces repeated draft screenshots. It does not replace the final PPTX render because PowerPoint and LibreOffice can use different font metrics and object reconstruction from Chromium.

### 6. Mandatory Final Visual QA and Revision Loop

1. Run `scripts/html_to_ppt.js` on the authored HTML.
2. Render the resulting PPTX into full-size slide images and a contact sheet. Do not judge only from the source HTML or assume a successful conversion is visually correct:

```bash
node /path/to/learn-deck/scripts/render_pptx_preview.js \
  --input /path/to/output/deck-name-editable.pptx \
  --out-dir /path/to/output/deck-name-qa
```

3. **Pass 1 — inspect the contact sheet first.** Open `contact-sheet.png` with an image-viewing tool. Review the deck as one sequence for narrative flow, pacing, composition variety, repeated silhouettes, density balance, consistent margins/title hierarchy/color/footer/page markers, and unexpectedly empty or overloaded slides.
4. **Pass 2 — inspect every slide at full size.** Open every PNG under `slides/`; the contact sheet does not replace this pass. Check title wrapping, text clipping or overflow, unintended overlap, icon centering, fine alignment, contrast, chart labels and data, and decorative objects that are too large or misleading when selected in PowerPoint. Pay special attention to the first and last characters of centered multiline labels inside circles, pills, and compact cards; line-break conversion can reveal clipping that is invisible in the HTML.
5. If either pass finds a problem, edit the original HTML, not an intermediate JSON or the rendered preview. Reconvert the PPTX, rerender all previews, and repeat both passes. Do not patch only the affected PNG, and do not reuse a stale contact sheet.
6. Deliver only after the latest contact sheet and every latest full-size slide have been inspected and there is zero unintended overflow, clipping, overlap, wrapping, icon drift, visual imbalance, or accidental layout repetition. If an intentional exception remains, disclose it explicitly.

This final QA loop is mandatory for a final deck, even when the browser DOM audit passes. The DOM audit catches HTML geometry and semantic guard failures; the final render catches PowerPoint font-metric changes, reconstruction differences, weak hierarchy, poor rhythm, and composition problems.

## What the Converter Preserves

The converter:

1. Loads the HTML in Chromium/Chrome through Playwright and waits for fonts.
2. Detects `.slide` roots, or another selector passed with `--slide-selector`.
3. Automatically audits slide/text overflow and enforces explicit containment, overlap, wrapping, centering, icon, and chart-label guards before reading visible DOM bounding boxes, computed styles, text runs, pseudo bullets, and inline SVG children.
4. Rebuilds editable text boxes and native rectangle, rounded-rectangle, ellipse, border, shadow, and gradient objects.
5. Saves inline SVG sources and PNG compatibility assets beside the PPTX.

The result favors editable, separated elements over screenshot-perfect reproduction.

## Legacy JSON Generator

`scripts/generate_ppt.js` remains available for backwards compatibility and deterministic batch output. It accepts `examples/slides.example.json` and renders a small fixed layout set. Do not use it for normal creative generation, reference-driven styling, or requests for custom composition.

```bash
node scripts/generate_ppt.js --help
node scripts/html_to_ppt.js --help-converter
```

## Important Options

- `--input <file-or-url>`: Required local HTML file or HTTP(S) URL.
- `--out-dir <dir>`: Required output directory.
- `--name <base>`: Output basename. Defaults to the input filename.
- `--slide-selector <css>`: Defaults to `.slide`.
- `--chrome <path>`: Use a specific Chrome/Edge/Chromium executable.
- `--ppt-width <inches>` and `--ppt-height <inches>`: Defaults to 13.333 × 7.5.
- `--font-face <name>`: Font used for editable PPT text. Use `PingFang SC` for Chinese or another installed font requested by the user.
- `--dom-audit-only`: Run the Chromium DOM audit and exit without requiring `--out-dir` or writing a PPTX.
- `--keep-raw`: Keep the intermediate PPTX before gradient patches.
- `--no-preview`: Skip the LibreOffice preview attempt. Do not use this for a final deck unless an equivalent full-slide render-and-inspect step is performed separately.

`scripts/render_pptx_preview.js` requires LibreOffice, Poppler (`pdftoppm`), and `sharp`. It produces a PDF, full-size slide PNGs, and `contact-sheet.png` for the mandatory two-pass QA loop.

## Bundled Style Template

- `templates/learn-deck-polished-style.html`: seven-slide converter-compatible composition library for the polished light LearnDeck aesthetic.
- `templates/learn-deck-polished-style.pptx`: editable rendered reference for checking the expected result.
- `templates/learn-deck-showcase-zh.pptx`
- `templates/learn-deck-showcase-en.pptx`

Use these to study visual quality and converter-compatible construction. They provide style, not user content or fixed layouts.
