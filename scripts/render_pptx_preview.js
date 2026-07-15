#!/usr/bin/env node
/* Render a PPTX as full-size slide PNGs plus a contact sheet for visual QA. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const MODULE_ROOTS = [
  ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"),
  path.join(os.homedir(), "node_modules"),
  path.join(process.cwd(), "node_modules"),
].filter(Boolean);

function requirePackage(name) {
  try {
    return require(require.resolve(name, { paths: MODULE_ROOTS }));
  } catch {
    throw new Error(`Cannot find required package "${name}". Set NODE_PATH to a node_modules directory that contains it.`);
  }
}

const sharp = requirePackage("sharp");

function usage(exitCode = 0) {
  console.log(`Usage:
  render_pptx_preview.js --input <deck.pptx> [options]

Options:
  --input <path>          Required PPTX file
  --out-dir <dir>        Defaults to <pptx-dir>/<pptx-name>-qa
  --columns <number>     Contact-sheet columns, defaults to 4
  --thumb-width <px>     Contact-sheet thumbnail width, defaults to 360
  --dpi <number>         Full-size slide render resolution, defaults to 144
  --help                  Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = { columns: 4, thumbWidth: 360, dpi: 144 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === "--help" || arg === "-h") usage(0);
    else if (arg === "--input") opts.input = next();
    else if (arg === "--out-dir") opts.outDir = next();
    else if (arg === "--columns") opts.columns = Number(next());
    else if (arg === "--thumb-width") opts.thumbWidth = Number(next());
    else if (arg === "--dpi") opts.dpi = Number(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.input) throw new Error("--input is required");
  for (const [name, value] of [["columns", opts.columns], ["thumb-width", opts.thumbWidth], ["dpi", opts.dpi]]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  }
  return opts;
}

function findExecutable(candidates, label) {
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      return execFileSync("which", [candidate], { encoding: "utf8" }).trim();
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`${label} was not found. Install LibreOffice and Poppler, or add their executables to PATH.`);
}

function naturalSort(files) {
  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

async function buildContactSheet(slideFiles, outputPath, columns, thumbWidth) {
  const thumbs = [];
  for (const file of slideFiles) {
    const input = await sharp(file).resize({ width: thumbWidth }).png().toBuffer();
    const metadata = await sharp(input).metadata();
    thumbs.push({ input, width: metadata.width, height: metadata.height });
  }

  const gap = 24;
  const outer = 32;
  const labelHeight = 34;
  const maxThumbHeight = Math.max(...thumbs.map((thumb) => thumb.height));
  const rows = Math.ceil(thumbs.length / columns);
  const sheetWidth = outer * 2 + columns * thumbWidth + (columns - 1) * gap;
  const sheetHeight = outer * 2 + rows * (maxThumbHeight + labelHeight) + (rows - 1) * gap;
  const composites = [];

  for (let i = 0; i < thumbs.length; i += 1) {
    const row = Math.floor(i / columns);
    const column = i % columns;
    const itemsInRow = Math.min(columns, thumbs.length - row * columns);
    const rowOffset = ((columns - itemsInRow) * (thumbWidth + gap)) / 2;
    const left = outer + rowOffset + column * (thumbWidth + gap);
    const top = outer + row * (maxThumbHeight + labelHeight + gap);
    const thumb = thumbs[i];
    composites.push({
      input: Buffer.from(`<svg width="${thumbWidth + 4}" height="${thumb.height + 4}" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="${thumbWidth}" height="${thumb.height}" rx="3" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/></svg>`),
      left: left - 2,
      top: top - 2,
    });
    composites.push({ input: thumb.input, left, top });
    composites.push({
      input: Buffer.from(`<svg width="${thumbWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><text x="${thumbWidth / 2}" y="24" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="600" fill="#475569">Slide ${i + 1}</text></svg>`),
      left,
      top: top + maxThumbHeight,
    });
  }

  await sharp({
    create: { width: sheetWidth, height: sheetHeight, channels: 4, background: "#eef2f7" },
  }).composite(composites).png().toFile(outputPath);
}

async function main() {
  const opts = parseArgs(process.argv);
  const input = path.resolve(opts.input);
  if (!fs.existsSync(input)) throw new Error(`PPTX not found: ${input}`);
  if (path.extname(input).toLowerCase() !== ".pptx") throw new Error(`Expected a .pptx file: ${input}`);

  const baseName = path.basename(input, path.extname(input));
  const outDir = path.resolve(opts.outDir || path.join(path.dirname(input), `${baseName}-qa`));
  const slidesDir = path.join(outDir, "slides");
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(slidesDir, { recursive: true, force: true });
  fs.mkdirSync(slidesDir, { recursive: true });

  const soffice = findExecutable([
    "/opt/homebrew/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "soffice",
  ], "LibreOffice");
  const pdftoppm = findExecutable(["pdftoppm"], "pdftoppm");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-deck-preview-"));

  try {
    const pdfDir = path.join(tempDir, "pdf");
    const profileDir = path.join(tempDir, "lo-profile");
    fs.mkdirSync(pdfDir, { recursive: true });
    execFileSync(soffice, [
      `-env:UserInstallation=file://${profileDir}`,
      "--headless",
      "--convert-to", "pdf",
      "--outdir", pdfDir,
      input,
    ], { stdio: "ignore" });

    const converted = fs.readdirSync(pdfDir).find((file) => path.extname(file).toLowerCase() === ".pdf");
    if (!converted) throw new Error("LibreOffice did not produce a PDF preview.");
    const pdfPath = path.join(outDir, `${baseName}.pdf`);
    fs.copyFileSync(path.join(pdfDir, converted), pdfPath);

    execFileSync(pdftoppm, ["-png", "-r", String(opts.dpi), pdfPath, path.join(slidesDir, "slide")], { stdio: "ignore" });
    const slideFiles = naturalSort(fs.readdirSync(slidesDir)
      .filter((file) => /^slide-\d+\.png$/i.test(file))
      .map((file) => path.join(slidesDir, file)));
    if (!slideFiles.length) throw new Error("pdftoppm did not produce slide PNGs.");

    const contactSheet = path.join(outDir, "contact-sheet.png");
    await buildContactSheet(slideFiles, contactSheet, opts.columns, opts.thumbWidth);
    console.log(JSON.stringify({ input, pdf: pdfPath, slides: slideFiles, contactSheet, slideCount: slideFiles.length }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
