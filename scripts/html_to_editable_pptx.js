#!/usr/bin/env node
/* Convert browser-rendered HTML slides into editable PPTX objects.
 *
 * Dependencies: playwright, pptxgenjs, sharp, jszip.
 * The script searches common Codex Desktop dependency locations in addition to NODE_PATH.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const COMMON_MODULE_ROOTS = [
  ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"),
  path.join(os.homedir(), "node_modules"),
  path.join(process.cwd(), "node_modules"),
].filter(Boolean);

function requireFromCandidates(name, extraRoots = []) {
  const roots = [...extraRoots, ...COMMON_MODULE_ROOTS];
  try {
    const resolved = require.resolve(name, { paths: roots });
    return { module: require(resolved), resolved };
  } catch (err) {
    const tried = roots.join("\n  ");
    throw new Error(`Cannot find required package "${name}". Tried:\n  ${tried}\nSet NODE_PATH to a node_modules directory that contains it.`);
  }
}

const { module: pptxgen, resolved: pptxResolved } = requireFromCandidates("pptxgenjs");
const { module: playwright } = requireFromCandidates("playwright");
const { module: sharp } = requireFromCandidates("sharp");
const { module: JSZip } = requireFromCandidates("jszip", [path.dirname(pptxResolved), path.join(path.dirname(pptxResolved), "..")]);

function usage(exitCode = 0) {
  console.log(`Usage:
  html_to_editable_pptx.js --input <file-or-url> [--out-dir <dir>] [options]

Options:
  --input <path|url>          Required local HTML file or http(s) URL
  --out-dir <dir>             Required output directory
  --name <base>               Output basename, defaults to input filename
  --slide-selector <css>      Slide selector, defaults to .slide
  --chrome <path>             Chrome/Edge/Chromium executable path
  --ppt-width <inches>        PPT width, defaults to 13.333333
  --ppt-height <inches>       PPT height, defaults to 7.5
  --font-face <name>          PPT font face, defaults to PingFang SC
  --viewport-width <px>       Browser viewport width, defaults to first slide width or 1280
  --viewport-height <px>      Browser viewport height, defaults to first slide height or 720
  --dom-audit-only            Validate the rendered DOM and exit without creating a PPTX
  --keep-raw                  Keep intermediate raw PPTX before gradient patches
  --no-preview                Skip LibreOffice/Quick Look preview attempt
  --help                      Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    slideSelector: ".slide",
    pptWidth: 13.3333333333,
    pptHeight: 7.5,
    fontFace: "PingFang SC",
    keepRaw: false,
    preview: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--input") out.input = next();
    else if (a === "--out-dir") out.outDir = next();
    else if (a === "--name") out.name = next();
    else if (a === "--slide-selector") out.slideSelector = next();
    else if (a === "--chrome") out.chrome = next();
    else if (a === "--ppt-width") out.pptWidth = Number(next());
    else if (a === "--ppt-height") out.pptHeight = Number(next());
    else if (a === "--font-face") out.fontFace = next();
    else if (a === "--viewport-width") out.viewportWidth = Number(next());
    else if (a === "--viewport-height") out.viewportHeight = Number(next());
    else if (a === "--dom-audit-only") out.domAuditOnly = true;
    else if (a === "--keep-raw") out.keepRaw = true;
    else if (a === "--no-preview") out.preview = false;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.input) throw new Error("--input is required");
  if (!out.outDir && !out.domAuditOnly) throw new Error("--out-dir is required unless --dom-audit-only is used");
  if (!Number.isFinite(out.pptWidth) || !Number.isFinite(out.pptHeight)) throw new Error("--ppt-width/--ppt-height must be numbers");
  return out;
}

function fileUrl(input) {
  if (/^https?:\/\//i.test(input) || /^file:\/\//i.test(input)) return input;
  return `file://${path.resolve(input)}`;
}

function defaultName(input) {
  if (/^https?:\/\//i.test(input)) {
    const u = new URL(input);
    return path.basename(u.pathname, path.extname(u.pathname)) || "learn-deck";
  }
  return path.basename(input, path.extname(input)) || "learn-deck";
}

function findBrowser(userPath) {
  const candidates = [
    userPath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function safeName(s) {
  return String(s || "object").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "object";
}

function rgbParts(css) {
  if (!css) return { hex: "000000", alpha: 1 };
  const hex = String(css).match(/#([0-9a-fA-F]{6})/);
  if (hex) return { hex: hex[1].toUpperCase(), alpha: 1 };
  const m = String(css).match(/rgba?\(([^)]+)\)/i);
  if (!m) return { hex: "000000", alpha: 1 };
  const parts = m[1].split(",").map((x) => x.trim());
  const nums = parts.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(parseFloat(x)))));
  const alpha = parts[3] == null ? 1 : Math.max(0, Math.min(1, parseFloat(parts[3])));
  return { hex: nums.map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase(), alpha };
}

function isTransparent(css) {
  return rgbParts(css).alpha <= 0.01;
}

function pxNum(value, fallback = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function gradientFunctions(backgroundImage, name) {
  const out = [];
  const source = String(backgroundImage || "");
  let idx = 0;
  while (idx < source.length) {
    const start = source.indexOf(`${name}(`, idx);
    if (start < 0) break;
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      if (source[end] === ")") {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    out.push(source.slice(start, end));
    idx = end;
  }
  return out;
}

function splitTopLevelCommas(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

function firstTwoGradientColors(backgroundImage) {
  const gradients = gradientFunctions(backgroundImage, "linear-gradient");
  const source = gradients[0] || String(backgroundImage || "");
  return [...source.matchAll(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/g)]
    .map((m) => rgbParts(m[0]))
    .filter((c) => c.alpha > 0.01)
    .slice(0, 2)
    .map((c) => c.hex);
}

function linearGradientAngle(backgroundImage, fallback = 150) {
  const gradients = gradientFunctions(backgroundImage, "linear-gradient");
  if (!gradients[0]) return fallback;
  const m = gradients[0].match(/linear-gradient\(\s*([-0-9.]+)deg/i);
  return m ? Number(m[1]) : fallback;
}

function parseRadials(backgroundImage, slideBox) {
  return gradientFunctions(backgroundImage, "radial-gradient").map((g, idx) => {
    const inside = g.slice(g.indexOf("(") + 1, -1);
    const parts = splitTopLevelCommas(inside);
    const descriptor = parts[0] || "";
    const colorStop = parts.find((p, i) => i > 0 && /#[0-9a-fA-F]{6}|rgba?\(/.test(p)) || "";
    const color = rgbParts((colorStop.match(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/) || ["#FFFFFF"])[0]);
    const sizeMatch = descriptor.match(/([0-9.]+)px\s+([0-9.]+)px/i);
    const atMatch = descriptor.match(/\bat\s+([-0-9.]+)%\s+([-0-9.]+)%/i);
    const w = sizeMatch ? Number(sizeMatch[1]) : slideBox.w * 0.8;
    const h = sizeMatch ? Number(sizeMatch[2]) : slideBox.h * 0.6;
    const cx = atMatch ? (Number(atMatch[1]) / 100) * slideBox.w : slideBox.w / 2;
    const cy = atMatch ? (Number(atMatch[2]) / 100) * slideBox.h : slideBox.h / 2;
    return { name: `radial_background_${idx + 1}`, box: { x: cx - w / 2, y: cy - h / 2, w, h }, color: color.hex, alpha: color.alpha };
  });
}

function boxShadowToPpt(css, pxToPt) {
  if (!css || css === "none") return undefined;
  const colorMatch = css.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{6}/);
  const nums = css.replace(/rgba?\([^)]*\)/g, "").match(/-?[0-9.]+px/g) || [];
  const color = rgbParts(colorMatch ? colorMatch[0] : "rgba(0,0,0,.25)");
  const offsetX = nums[0] ? pxNum(nums[0]) : 0;
  const offsetY = nums[1] ? pxNum(nums[1]) : 2;
  const blur = nums[2] ? pxNum(nums[2]) : 8;
  const angle = Math.round((Math.atan2(offsetY, offsetX) * 180) / Math.PI);
  return {
    type: "outer",
    color: color.hex,
    opacity: Math.max(0.05, Math.min(0.8, color.alpha)),
    blur: Math.max(1, blur * pxToPt * 0.7),
    angle: Number.isFinite(angle) ? (angle + 360) % 360 : 90,
    offset: Math.max(0.5, Math.sqrt(offsetX * offsetX + offsetY * offsetY) * pxToPt),
  };
}

async function collectDom(page, opts) {
  return page.evaluate(({ slideSelector }) => {
    const roots = [...document.querySelectorAll(slideSelector)];
    if (!roots.length) roots.push(document.body);

    function visible(el) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0;
    }
    function relBox(el, rootRect) {
      const r = el.getBoundingClientRect();
      return { x: r.x - rootRect.x, y: r.y - rootRect.y, w: r.width, h: r.height };
    }
    function style(el) {
      const s = getComputedStyle(el);
      return {
        tag: el.tagName,
        id: el.id || "",
        cls: typeof el.className === "string" ? el.className : "",
        display: s.display,
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        fontWeight: s.fontWeight,
        fontStyle: s.fontStyle,
        color: s.color,
        backgroundColor: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        backgroundClip: s.backgroundClip,
        webkitBackgroundClip: s.getPropertyValue("-webkit-background-clip"),
        webkitTextFillColor: s.getPropertyValue("-webkit-text-fill-color"),
        borderTopColor: s.borderTopColor,
        borderTopWidth: s.borderTopWidth,
        borderRadius: s.borderRadius,
        boxShadow: s.boxShadow,
        letterSpacing: s.letterSpacing,
        textAlign: s.textAlign,
        justifyContent: s.justifyContent,
        alignItems: s.alignItems,
        opacity: s.opacity,
        paddingLeft: s.paddingLeft,
        paddingRight: s.paddingRight,
        paddingTop: s.paddingTop,
        paddingBottom: s.paddingBottom,
      };
    }
    function contentBox(el, rootRect) {
      const b = relBox(el, rootRect);
      const s = getComputedStyle(el);
      const pl = parseFloat(s.paddingLeft) || 0;
      const pr = parseFloat(s.paddingRight) || 0;
      const pt = parseFloat(s.paddingTop) || 0;
      const pb = parseFloat(s.paddingBottom) || 0;
      return { x: b.x + pl, y: b.y + pt, w: Math.max(1, b.w - pl - pr), h: Math.max(1, b.h - pt - pb) };
    }
    function hasVisual(el) {
      const s = getComputedStyle(el);
      const textClip = s.backgroundClip === "text" || s.getPropertyValue("-webkit-background-clip") === "text";
      const bgVisible = !/^rgba?\(0,\s*0,\s*0,\s*0\)$/i.test(s.backgroundColor) && s.backgroundColor !== "transparent";
      const hasBgImage = s.backgroundImage && s.backgroundImage !== "none" && !textClip;
      const border = (parseFloat(s.borderTopWidth) || 0) > 0 && s.borderTopStyle !== "none";
      const shadow = s.boxShadow && s.boxShadow !== "none";
      return bgVisible || hasBgImage || border || shadow;
    }
    function ownText(el) {
      return [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    }
    function textCandidate(el) {
      if (el.tagName === "SVG" || el.closest("svg")) return false;
      const text = (el.innerText || el.textContent || "").trim();
      if (!text) return false;
      const tag = el.tagName;
      const directTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "LI", "SPAN", "A", "BUTTON", "LABEL", "TD", "TH"]);
      if (directTags.has(tag)) return true;
      if (tag === "DIV" && ownText(el)) return true;
      if (tag === "DIV") {
        return ![...el.children].some((child) => visible(child) && (child.innerText || child.textContent || "").trim() && getComputedStyle(child).display !== "inline");
      }
      return ownText(el);
    }
    function runStyle(node) {
      const s = getComputedStyle(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
      return {
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        fontStyle: s.fontStyle,
        color: s.color,
        letterSpacing: s.letterSpacing,
      };
    }
    function textRuns(el) {
      const runs = [];
      function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.replace(/\s+/g, " ");
          if (text) runs.push({ text, style: runStyle(node) });
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.tagName === "BR") {
          runs.push({ text: "\n", style: runStyle(node.parentElement || el) });
          return;
        }
        for (const child of node.childNodes) walk(child);
      }
      walk(el);
      return runs.length ? runs : [{ text: el.innerText || el.textContent || "", style: runStyle(el) }];
    }
    function pseudoBefore(el, rootRect) {
      const p = getComputedStyle(el, "::before");
      if (!p || p.content === "none" || p.content === "normal") return null;
      const w = parseFloat(p.width) || 0;
      const h = parseFloat(p.height) || 0;
      if (!w || !h) return null;
      const b = relBox(el, rootRect);
      const left = b.x + (parseFloat(p.left) || 0);
      const top = b.y + (parseFloat(p.top) || 0);
      return { box: { x: left, y: top, w, h }, style: { backgroundColor: p.backgroundColor, borderRadius: p.borderRadius } };
    }
    function svgOuter(svg) {
      const clone = svg.cloneNode(true);
      const st = getComputedStyle(svg);
      const stroke = st.stroke && st.stroke !== "none" ? st.stroke : "#000000";
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      if (!clone.getAttribute("stroke")) clone.setAttribute("stroke", stroke);
      if (!clone.getAttribute("fill")) clone.setAttribute("fill", st.fill && st.fill !== "none" ? st.fill : "none");
      clone.querySelectorAll("*").forEach((n) => {
        if (!n.getAttribute("stroke") && stroke !== "none") n.setAttribute("stroke", stroke);
      });
      return clone.outerHTML;
    }

    function elementLabel(el) {
      if (el.id) return `#${el.id}`;
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
    }

    function ignored(el) {
      return Boolean(el.closest("[data-layout-ignore]"));
    }

    function plainRect(rect) {
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }

    function relativeRect(rect, rootRect) {
      return { x: rect.left - rootRect.left, y: rect.top - rootRect.top, w: rect.width, h: rect.height };
    }

    function innerRect(el) {
      const rect = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const left = rect.left + (parseFloat(s.borderLeftWidth) || 0) + (parseFloat(s.paddingLeft) || 0);
      const right = rect.right - (parseFloat(s.borderRightWidth) || 0) - (parseFloat(s.paddingRight) || 0);
      const top = rect.top + (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.paddingTop) || 0);
      const bottom = rect.bottom - (parseFloat(s.borderBottomWidth) || 0) - (parseFloat(s.paddingBottom) || 0);
      return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }

    function outsideEdges(rect, parent, tolerance) {
      const edges = [];
      if (rect.left < parent.left - tolerance) edges.push("left");
      if (rect.top < parent.top - tolerance) edges.push("top");
      if (rect.right > parent.right + tolerance) edges.push("right");
      if (rect.bottom > parent.bottom + tolerance) edges.push("bottom");
      return edges;
    }

    function textOutsideEdges(rect, parent) {
      const horizontalTolerance = 1.5;
      const verticalTolerance = Math.max(2, Math.min(14, rect.height * 0.16));
      const edges = [];
      if (rect.left < parent.left - horizontalTolerance) edges.push("left");
      if (rect.right > parent.right + horizontalTolerance) edges.push("right");
      if (rect.top < parent.top - verticalTolerance) edges.push("top");
      if (rect.bottom > parent.bottom + verticalTolerance) edges.push("bottom");
      return edges;
    }

    function textLineRects(el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()]
        .filter((rect) => rect.width > 0.25 && rect.height > 0.25)
        .map(plainRect)
        .sort((a, b) => a.top - b.top || a.left - b.left);
      const lines = [];
      for (const rect of rects) {
        const line = lines.find((candidate) => Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top) > 0.75);
        if (!line) {
          lines.push({ ...rect });
          continue;
        }
        line.left = Math.min(line.left, rect.left);
        line.top = Math.min(line.top, rect.top);
        line.right = Math.max(line.right, rect.right);
        line.bottom = Math.max(line.bottom, rect.bottom);
        line.width = line.right - line.left;
        line.height = line.bottom - line.top;
      }
      return lines;
    }

    function layoutGuardIssues(root, rootRect) {
      const tolerance = 0.75;
      const issues = [];
      const modeCounts = {};
      const all = [...root.querySelectorAll("*")].filter((el) => visible(el) && !ignored(el));

      for (const el of all) {
        if (!el.closest("[data-layout-allow-overflow]")) {
          const box = el.getBoundingClientRect();
          const edges = outsideEdges(box, rootRect, tolerance);
          if (edges.length) {
            issues.push({
              type: "slide-overflow",
              element: elementLabel(el),
              edges,
              slideBox: { x: 0, y: 0, w: rootRect.width, h: rootRect.height },
              elementBox: relativeRect(box, rootRect),
            });
          }
        }

        if (!textCandidate(el)) continue;
        const lines = textLineRects(el);
        const content = innerRect(el);
        const overflowing = lines.find((line) => textOutsideEdges(line, content).length);
        const computed = getComputedStyle(el);
        const clippedX = computed.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1;
        const clippedY = computed.overflowY !== "visible" && el.scrollHeight > el.clientHeight + 1;
        const scrollOverflow = el.clientWidth > 0 && el.clientHeight > 0 && (clippedX || clippedY);
        if (overflowing || scrollOverflow) {
          issues.push({
            type: "text-overflow",
            element: elementLabel(el),
            edges: overflowing ? textOutsideEdges(overflowing, content) : ["scroll-size"],
            contentBox: relativeRect(content, rootRect),
            textBox: overflowing ? relativeRect(overflowing, rootRect) : undefined,
            scrollSize: scrollOverflow ? { width: el.scrollWidth, height: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight } : undefined,
          });
        }
      }

      const guards = [...root.querySelectorAll("[data-layout-guard]")].filter(visible);
      for (const guard of guards) {
        const modes = new Set((guard.getAttribute("data-layout-guard") || "").split(/\s+/).filter(Boolean));
        for (const mode of modes) modeCounts[mode] = (modeCounts[mode] || 0) + 1;
        const parent = guard.getBoundingClientRect();
        const children = [...guard.children].filter(visible).map((el) => ({ el, box: el.getBoundingClientRect() }));
        if (modes.has("contain")) {
          for (const child of children) {
            const outside = [];
            if (child.box.left < parent.left - tolerance) outside.push("left");
            if (child.box.top < parent.top - tolerance) outside.push("top");
            if (child.box.right > parent.right + tolerance) outside.push("right");
            if (child.box.bottom > parent.bottom + tolerance) outside.push("bottom");
            if (outside.length) {
              issues.push({
                type: "contain",
                guard: elementLabel(guard),
                child: elementLabel(child.el),
                edges: outside,
                guardBox: relBox(guard, rootRect),
                childBox: relBox(child.el, rootRect),
              });
            }
          }
        }
        if (modes.has("no-overlap")) {
          for (let i = 0; i < children.length; i++) {
            for (let j = i + 1; j < children.length; j++) {
              const a = children[i];
              const b = children[j];
              const overlapW = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
              const overlapH = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
              if (overlapW > tolerance && overlapH > tolerance) {
                issues.push({
                  type: "overlap",
                  guard: elementLabel(guard),
                  first: elementLabel(a.el),
                  second: elementLabel(b.el),
                  overlap: { w: overlapW, h: overlapH },
                  firstBox: relBox(a.el, rootRect),
                  secondBox: relBox(b.el, rootRect),
                });
              }
            }
          }
        }
        if (modes.has("text-contain") || modes.has("single-line") || modes.has("text-center")) {
          const lines = textLineRects(guard);
          const content = innerRect(guard);
          if (modes.has("text-contain")) {
            for (const line of lines) {
              const edges = textOutsideEdges(line, content);
              if (edges.length) {
                issues.push({
                  type: "guarded-text-overflow",
                  guard: elementLabel(guard),
                  edges,
                  guardBox: relativeRect(content, rootRect),
                  textBox: relativeRect(line, rootRect),
                });
                break;
              }
            }

            const radius = parseFloat(getComputedStyle(guard).borderTopLeftRadius) || 0;
            const ellipseLike = Math.max(parent.width, parent.height) / Math.max(1, Math.min(parent.width, parent.height)) < 1.2
              && radius >= Math.min(parent.width, parent.height) * 0.45;
            if (ellipseLike) {
              const cx = parent.left + parent.width / 2;
              const cy = parent.top + parent.height / 2;
              const rx = parent.width / 2;
              const ry = parent.height / 2;
              for (const line of lines) {
                const dy = Math.abs((line.top + line.bottom) / 2 - cy);
                const available = dy < ry ? rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))) : 0;
                if (line.left < cx - available - 1.5 || line.right > cx + available + 1.5) {
                  issues.push({
                    type: "ellipse-text-overflow",
                    guard: elementLabel(guard),
                    guardBox: relativeRect(parent, rootRect),
                    textBox: relativeRect(line, rootRect),
                  });
                  break;
                }
              }
            }
          }
          if (modes.has("single-line") && lines.length > 1) {
            issues.push({ type: "unexpected-wrap", guard: elementLabel(guard), lines: lines.length, guardBox: relBox(guard, rootRect) });
          }
          if (modes.has("text-center") && lines.length) {
            const horizontalTolerance = Math.max(2.5, Math.min(8, content.width * 0.03));
            const offCenterLine = lines.find((line) => Math.abs((line.left + line.right) / 2 - (content.left + content.right) / 2) > horizontalTolerance);
            const textTop = Math.min(...lines.map((line) => line.top));
            const textBottom = Math.max(...lines.map((line) => line.bottom));
            const dx = offCenterLine ? (offCenterLine.left + offCenterLine.right) / 2 - (content.left + content.right) / 2 : 0;
            const dy = (textTop + textBottom) / 2 - (content.top + content.bottom) / 2;
            if (offCenterLine || Math.abs(dy) > Math.max(3, content.height * 0.06)) {
              issues.push({ type: "text-center-drift", guard: elementLabel(guard), drift: { x: dx, y: dy }, guardBox: relativeRect(content, rootRect) });
            }
          }
        }
        if (modes.has("icon-center")) {
          const icons = [...guard.querySelectorAll("svg")].filter(visible);
          if (icons.length !== 1) {
            issues.push({ type: "icon-count", guard: elementLabel(guard), expected: 1, actual: icons.length });
          } else {
            const content = innerRect(guard);
            const icon = icons[0].getBoundingClientRect();
            const dx = (icon.left + icon.right) / 2 - (content.left + content.right) / 2;
            const dy = (icon.top + icon.bottom) / 2 - (content.top + content.bottom) / 2;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
              issues.push({ type: "icon-center-drift", guard: elementLabel(guard), drift: { x: dx, y: dy }, iconBox: relativeRect(icon, rootRect), guardBox: relativeRect(content, rootRect) });
            }
          }
        }
        if (modes.has("chart-labels")) {
          const series = [...guard.querySelectorAll(":scope > [data-chart-series]")].filter(visible);
          if (!series.length) issues.push({ type: "chart-series-missing", guard: elementLabel(guard) });
          for (const item of series) {
            const label = item.querySelector("[data-chart-label]");
            if (!label || !visible(label) || !(label.innerText || label.textContent || "").trim()) {
              issues.push({ type: "chart-label-missing", guard: elementLabel(guard), series: elementLabel(item) });
              continue;
            }
            const seriesBox = item.getBoundingClientRect();
            const labelBox = label.getBoundingClientRect();
            const edges = outsideEdges(labelBox, seriesBox, tolerance);
            if (edges.length) issues.push({ type: "chart-label-overflow", guard: elementLabel(guard), series: elementLabel(item), label: elementLabel(label), edges });
          }
        }
      }
      return { count: guards.length, modeCounts, issues };
    }

    return roots.map((root, slideIndex) => {
      const rootRect = root.getBoundingClientRect();
      const all = [...root.querySelectorAll("*")].filter(visible);
      const guardResult = layoutGuardIssues(root, rootRect);
      return {
        slideIndex,
        box: { x: 0, y: 0, w: rootRect.width, h: rootRect.height },
        rootStyle: style(root),
        layoutGuardCount: guardResult.count,
        layoutGuardModes: guardResult.modeCounts,
        layoutIssues: guardResult.issues,
        elements: all.map((el, idx) => {
          const tc = textCandidate(el);
          const parentTc = el.parentElement && root.contains(el.parentElement) && textCandidate(el.parentElement);
          return {
            idx,
            tag: el.tagName,
            id: el.id || "",
            cls: typeof el.className === "string" ? el.className : "",
            box: relBox(el, rootRect),
            contentBox: contentBox(el, rootRect),
            style: style(el),
            hasVisual: hasVisual(el),
            textCandidate: tc,
            parentTextCandidate: Boolean(parentTc),
            text: el.innerText || el.textContent || "",
            runs: tc ? textRuns(el) : [],
            before: pseudoBefore(el, rootRect),
          };
        }),
        svgs: [...root.querySelectorAll("svg")].filter(visible).map((svg, idx) => ({
          idx,
          box: relBox(svg, rootRect),
          svg: svgOuter(svg),
        })),
      };
    });
  }, { slideSelector: opts.slideSelector });
}

function makeContext(slideBox, pptW, pptH) {
  const sx = pptW / slideBox.w;
  const sy = pptH / slideBox.h;
  const pxToPt = sx * 72;
  return {
    sx,
    sy,
    pxToPt,
    pos: (b) => ({ x: b.x * sx, y: b.y * sy, w: Math.max(0.001, b.w * sx), h: Math.max(0.001, b.h * sy) }),
    pt: (px) => px * pxToPt,
  };
}

function addShape(slide, type, name, box, fillColor, ctx, opts = {}) {
  slide.addShape(type, {
    objectName: name,
    ...ctx.pos(box),
    fill: { color: fillColor, transparency: opts.transparency || 0 },
    line: opts.line || { color: "FFFFFF", transparency: 100 },
    rectRadius: opts.rectRadiusPx ? opts.rectRadiusPx * ctx.sx : undefined,
    shadow: opts.shadow,
  });
}

function addText(slide, name, item, box, ctx, opts) {
  const style = item.style || {};
  const color = rgbParts(style.color);
  const fallbackColor = opts.fallbackColor || "1E293B";
  const horizontalAlign = style.textAlign === "center" || style.justifyContent === "center"
    ? "center"
    : style.textAlign === "right" || style.justifyContent === "flex-end"
      ? "right"
      : "left";
  const verticalAlign = style.alignItems === "center" ? "mid" : style.alignItems === "flex-end" ? "bottom" : "top";
  const runs = [];
  for (const r of item.runs || []) {
    if (r.text === "\n") {
      if (runs.length) runs[runs.length - 1].options.breakLine = true;
      continue;
    }
    const rs = r.style || style;
    const c = rgbParts(rs.color);
    runs.push({
      text: r.text,
      options: {
        fontFace: opts.fontFace,
        fontSize: ctx.pt(pxNum(rs.fontSize, pxNum(style.fontSize, 12))),
        color: c.alpha <= 0.01 ? fallbackColor : c.hex,
        bold: Number(rs.fontWeight || style.fontWeight || 400) >= 600,
        italic: rs.fontStyle === "italic",
        charSpacing: pxNum(rs.letterSpacing, 0) ? ctx.pt(pxNum(rs.letterSpacing, 0)) : undefined,
        breakLine: false,
      },
    });
  }
  slide.addText(runs.length ? runs : item.text, {
    objectName: name,
    ...ctx.pos(box),
    fontFace: opts.fontFace,
    fontSize: ctx.pt(pxNum(style.fontSize, 12)),
    color: color.alpha <= 0.01 ? fallbackColor : color.hex,
    transparency: color.alpha <= 0.01 ? 0 : Math.round((1 - color.alpha) * 100),
    bold: Number(style.fontWeight || 400) >= 600,
    italic: style.fontStyle === "italic",
    charSpacing: pxNum(style.letterSpacing, 0) ? ctx.pt(pxNum(style.letterSpacing, 0)) : undefined,
    align: horizontalAlign,
    lineSpacing: style.lineHeight && style.lineHeight !== "normal" ? ctx.pt(pxNum(style.lineHeight)) : undefined,
    margin: 0,
    fit: "none",
    breakLine: false,
    valign: verticalAlign,
  });
}

function expandedTextBox(item, slideBox) {
  const b = { ...(item.contentBox || item.box) };
  const size = pxNum(item.style && item.style.fontSize, 12);
  const extra = Math.max(8, Math.min(28, size * 1.4));
  const style = item.style || {};
  const align = style.textAlign === "center" || style.justifyContent === "center"
    ? "center"
    : style.textAlign === "right" || style.justifyContent === "flex-end"
      ? "right"
      : "left";
  if (align === "center") {
    const grow = Math.min(extra / 2, b.x, slideBox.w - b.x - b.w);
    b.x -= grow;
    b.w += grow * 2;
  } else if (align === "right") {
    const grow = Math.min(extra, b.x);
    b.x -= grow;
    b.w += grow;
  } else {
    b.w = Math.min(slideBox.w - b.x, b.w + extra);
  }
  b.h = Math.min(slideBox.h - b.y, b.h + Math.max(2, size * 0.25));
  return b;
}

function shouldSkipText(item) {
  if (!item.textCandidate || item.tag === "SVG" || item.text.trim() === "") return true;
  if (item.parentTextCandidate && ["B", "STRONG", "EM", "I", "U", "S", "SMALL", "SPAN"].includes(item.tag)) return true;
  return false;
}

async function saveSvgAssets(slideData, assetDir) {
  const svgDir = path.join(assetDir, "svg");
  const pngDir = path.join(assetDir, "png");
  fs.mkdirSync(svgDir, { recursive: true });
  fs.mkdirSync(pngDir, { recursive: true });
  const map = new Map();
  for (const s of slideData) {
    for (const svg of s.svgs) {
      const base = `slide-${String(s.slideIndex + 1).padStart(2, "0")}-icon-${String(svg.idx + 1).padStart(2, "0")}`;
      const svgPath = path.join(svgDir, `${base}.svg`);
      const pngPath = path.join(pngDir, `${base}.png`);
      fs.writeFileSync(svgPath, svg.svg, "utf8");
      const png = await sharp(Buffer.from(svg.svg)).png().toBuffer();
      fs.writeFileSync(pngPath, png);
      map.set(`${s.slideIndex}:${svg.idx}`, {
        svgPath,
        pngPath,
        data: `data:image/png;base64,${png.toString("base64")}`,
      });
    }
  }
  return { map, svgDir, pngDir };
}

function visualName(slideIdx, item) {
  const base = [item.tag.toLowerCase(), item.id, item.cls].filter(Boolean).join("_") || `element_${item.idx}`;
  return safeName(`s${slideIdx + 1}_${base}_${item.idx}`);
}

function shouldSkipVisual(item) {
  if (item.tag === "SVG" || item.tag === "PATH" || item.tag === "POLYLINE" || item.tag === "LINE" || item.tag === "CIRCLE" || item.tag === "RECT" || item.tag === "POLYGON") return true;
  return !item.hasVisual;
}

function primaryRadiusToken(item) {
  return String(item.style && item.style.borderRadius || "0").split(/\s+/)[0] || "0";
}

function primaryRadiusPx(item) {
  const token = primaryRadiusToken(item);
  if (/%$/.test(token)) {
    return (pxNum(token, 0) / 100) * Math.min(item.box.w, item.box.h);
  }
  return pxNum(token, 0);
}

function hasEllipseRadius(item) {
  const token = primaryRadiusToken(item);
  if (/%$/.test(token) && pxNum(token, 0) >= 49) return true;
  const radius = primaryRadiusPx(item);
  const minSide = Math.min(item.box.w, item.box.h);
  const aspect = Math.max(item.box.w, item.box.h) / Math.max(1, minSide);
  return aspect < 1.15 && radius >= minSide / 2;
}

function shapeTypeFor(item) {
  if (hasEllipseRadius(item)) return "ellipse";
  const radius = primaryRadiusPx(item);
  return radius > 0 ? "roundRect" : "rect";
}

function lineFor(item, ctx) {
  const widthPx = pxNum(item.style.borderTopWidth, 0);
  const color = rgbParts(item.style.borderTopColor);
  if (!widthPx || color.alpha <= 0.01) return { color: "FFFFFF", transparency: 100 };
  return { color: color.hex, width: ctx.pt(widthPx), transparency: Math.round((1 - color.alpha) * 100) };
}

function addSlideObjects(pptSlide, slideData, ctx, opts, svgAssets, gradientPatches) {
  const rootColor = rgbParts(slideData.rootStyle.backgroundColor);
  addShape(pptSlide, "rect", `s${slideData.slideIndex + 1}_background_base`, slideData.box, rootColor.alpha > 0.01 ? rootColor.hex : "FFFFFF", ctx);
  for (const radial of parseRadials(slideData.rootStyle.backgroundImage, slideData.box)) {
    addShape(pptSlide, "ellipse", `s${slideData.slideIndex + 1}_${radial.name}`, radial.box, radial.color, ctx, { transparency: Math.round((1 - radial.alpha) * 100) + 8 });
  }

  for (const item of slideData.elements) {
    if (shouldSkipVisual(item)) continue;
    const name = `${visualName(slideData.slideIndex, item)}_shape`;
    const colors = firstTwoGradientColors(item.style.backgroundImage);
    const bg = rgbParts(item.style.backgroundColor);
    const fill = colors[0] || (bg.alpha > 0.01 ? bg.hex : "FFFFFF");
    const transparency = colors[0] ? 0 : Math.round((1 - bg.alpha) * 100);
    const shapeType = shapeTypeFor(item);
    addShape(pptSlide, shapeType, name, item.box, fill, ctx, {
      transparency,
      rectRadiusPx: shapeType === "roundRect" ? primaryRadiusPx(item) : undefined,
      line: lineFor(item, ctx),
      shadow: boxShadowToPpt(item.style.boxShadow, ctx.pxToPt),
    });
    if (colors.length >= 2 && /linear-gradient/i.test(item.style.backgroundImage)) {
      gradientPatches.push({ slideIndex: slideData.slideIndex, name, c1: colors[0], c2: colors[1], angle: linearGradientAngle(item.style.backgroundImage) });
    }
  }

  for (const item of slideData.elements) {
    if (!item.before) continue;
    const bg = rgbParts(item.before.style.backgroundColor);
    if (bg.alpha <= 0.01) continue;
    addShape(pptSlide, pxNum(item.before.style.borderRadius, 0) > 0 ? "ellipse" : "rect", `${visualName(slideData.slideIndex, item)}_before`, item.before.box, bg.hex, ctx, {
      transparency: Math.round((1 - bg.alpha) * 100),
    });
  }

  for (const svg of slideData.svgs) {
    const asset = svgAssets.get(`${slideData.slideIndex}:${svg.idx}`);
    if (!asset) continue;
    pptSlide.addImage({
      objectName: safeName(`s${slideData.slideIndex + 1}_svg_${svg.idx + 1}`),
      data: asset.data,
      ...ctx.pos(svg.box),
    });
  }

  for (const item of slideData.elements) {
    if (shouldSkipText(item)) continue;
    const name = `${visualName(slideData.slideIndex, item)}_text`;
    const textBox = expandedTextBox(item, slideData.box);
    const colors = firstTwoGradientColors(item.style.backgroundImage);
    addText(pptSlide, name, item, textBox, ctx, { fontFace: opts.fontFace, fallbackColor: colors[0] || "1E293B" });
    if (isTransparent(item.style.color) && colors.length >= 2 && /linear-gradient/i.test(item.style.backgroundImage)) {
      gradientPatches.push({ slideIndex: slideData.slideIndex, name, c1: colors[0], c2: colors[1], angle: linearGradientAngle(item.style.backgroundImage, 90), all: true });
    }
  }
}

function gradientXml(c1, c2, angle) {
  const ang = Math.round(Number(angle || 0) * 60000);
  return `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${c1}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${c2}"/></a:gs></a:gsLst><a:lin ang="${ang}" scaled="1"/></a:gradFill>`;
}

function patchShapeXml(xml, name, replacement, allSolid) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(<p:sp\\b(?:(?!</p:sp>).)*?<p:cNvPr\\b[^>]*\\bname="${escapedName}"[^>]*>.*?</p:sp>)`, "gs");
  let count = 0;
  const patched = xml.replace(re, (sp) => {
    count++;
    let replaced = false;
    return sp.replace(/<a:gradFill\b.*?<\/a:gradFill>|<a:solidFill>.*?<\/a:solidFill>/gs, (m, offset) => {
      if (!allSolid && replaced) return m;
      replaced = true;
      return replacement;
    });
  });
  return { xml: patched, count };
}

async function patchPptx(rawPath, outPath, gradientPatches) {
  const zip = await JSZip.loadAsync(fs.readFileSync(rawPath));
  const bySlide = new Map();
  for (const p of gradientPatches) {
    if (!bySlide.has(p.slideIndex)) bySlide.set(p.slideIndex, []);
    bySlide.get(p.slideIndex).push(p);
  }
  for (const [slideIndex, patches] of bySlide) {
    const name = `ppt/slides/slide${slideIndex + 1}.xml`;
    const file = zip.file(name);
    if (!file) continue;
    let xml = await file.async("string");
    for (const p of patches) {
      const res = patchShapeXml(xml, p.name, gradientXml(p.c1, p.c2, p.angle), Boolean(p.all));
      if (res.count === 0) console.warn(`Warning: gradient target not found: slide ${slideIndex + 1} ${p.name}`);
      xml = res.xml;
    }
    zip.file(name, xml);
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outPath, buf);
}

function tryPreview(pptxPath, outDir, baseName) {
  const soffice = ["/opt/homebrew/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice", "soffice"].find((p) => {
    if (p.includes("/")) return fs.existsSync(p);
    try {
      execFileSync("which", [p], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!soffice) return null;
  const previewDir = path.join(outDir, `${baseName}-preview`);
  fs.mkdirSync(previewDir, { recursive: true });
  try {
    execFileSync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", previewDir, pptxPath], { stdio: "ignore" });
    return previewDir;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const baseName = safeName(opts.name || defaultName(opts.input));

  const launchOptions = { headless: true };
  const browserPath = findBrowser(opts.chrome);
  if (browserPath) launchOptions.executablePath = browserPath;

  const browser = await playwright.chromium.launch(launchOptions);
  const page = await browser.newPage({
    viewport: { width: opts.viewportWidth || 1280, height: opts.viewportHeight || 720 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  await page.goto(fileUrl(opts.input), { waitUntil: "load", timeout: 60000 });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  });
  const slideData = await collectDom(page, opts);
  await browser.close();
  if (!slideData.length) throw new Error("No slide/body content found.");
  const layoutIssues = slideData.flatMap((slide) => (slide.layoutIssues || []).map((issue) => ({ slide: slide.slideIndex + 1, ...issue })));
  if (layoutIssues.length) {
    const details = layoutIssues.slice(0, 20).map((issue) => `slide ${issue.slide}: ${JSON.stringify(issue)}`).join("\n");
    const suffix = layoutIssues.length > 20 ? `\n... ${layoutIssues.length - 20} more issue(s)` : "";
    throw new Error(`HTML DOM audit failed with ${layoutIssues.length} issue(s):\n${details}${suffix}`);
  }

  const guardModes = {};
  for (const slide of slideData) {
    for (const [mode, count] of Object.entries(slide.layoutGuardModes || {})) guardModes[mode] = (guardModes[mode] || 0) + count;
  }
  const domAudit = {
    issues: 0,
    guardElements: slideData.reduce((n, slide) => n + (slide.layoutGuardCount || 0), 0),
    guardModes,
  };
  if (opts.domAuditOnly) {
    console.log(JSON.stringify({ mode: "dom-audit-only", input: opts.input, slides: slideData.length, domAudit }, null, 2));
    return;
  }

  const outDir = path.resolve(opts.outDir);
  const assetDir = path.join(outDir, `${baseName}-assets`);
  const rawPath = path.join(outDir, `${baseName}-editable.raw.pptx`);
  const outPath = path.join(outDir, `${baseName}-editable.pptx`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(assetDir, { recursive: true, force: true });

  const svgAssets = await saveSvgAssets(slideData, assetDir);
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "HTML_BROWSER_LAYOUT", width: opts.pptWidth, height: opts.pptHeight });
  pptx.layout = "HTML_BROWSER_LAYOUT";
  pptx.author = "Codex";
  pptx.subject = "Editable PPTX converted from HTML with DOM positions";
  pptx.title = baseName;
  pptx.lang = "zh-CN";
  pptx.theme = { headFontFace: opts.fontFace, bodyFontFace: opts.fontFace, lang: "zh-CN" };

  const gradientPatches = [];
  for (const s of slideData) {
    const slide = pptx.addSlide();
    slide.background = { color: rgbParts(s.rootStyle.backgroundColor).hex || "FFFFFF" };
    const ctx = makeContext(s.box, opts.pptWidth, opts.pptHeight);
    addSlideObjects(slide, s, ctx, opts, svgAssets.map, gradientPatches);
  }

  await pptx.writeFile({ fileName: rawPath });
  await patchPptx(rawPath, outPath, gradientPatches);
  if (!opts.keepRaw) fs.rmSync(rawPath, { force: true });

  let previewDir = null;
  if (opts.preview) previewDir = tryPreview(outPath, outDir, baseName);

  const summary = {
    output: outPath,
    slides: slideData.length,
    assets: { svgDir: svgAssets.svgDir, pngDir: svgAssets.pngDir, svgCount: svgAssets.map.size },
    objects: {
      visualElements: slideData.reduce((n, s) => n + s.elements.filter((e) => e.hasVisual).length, 0),
      textElements: slideData.reduce((n, s) => n + s.elements.filter((e) => e.textCandidate).length, 0),
      svgImages: svgAssets.map.size,
      gradientPatches: gradientPatches.length,
      layoutGuards: slideData.reduce((n, s) => n + (s.layoutGuardCount || 0), 0),
    },
    domAudit,
    previewDir,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
