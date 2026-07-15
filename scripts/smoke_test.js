#!/usr/bin/env node
/* Verify direct HTML, DOM auditing, layout guards, and legacy JSON compatibility. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "learn-deck-smoke-"));
let passed = false;

function run(script, args, expectFailure = false) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    throw new Error(`${script} ${expectFailure ? "unexpectedly succeeded" : "failed"} (status ${result.status})\n${output}`);
  }
  return output;
}

function assertPptx(file) {
  if (!fs.existsSync(file)) throw new Error(`Expected PPTX was not created: ${file}`);
  const stat = fs.statSync(file);
  if (stat.size < 10000) throw new Error(`PPTX is unexpectedly small (${stat.size} bytes): ${file}`);
  const header = fs.readFileSync(file).subarray(0, 2).toString("ascii");
  if (header !== "PK") throw new Error(`PPTX is not a ZIP/OOXML package: ${file}`);
}

function readZipMember(file, member) {
  const result = spawnSync("unzip", ["-p", file, member], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not read ${member} from ${file}\n${result.stderr || ""}`);
  return result.stdout;
}

function replaceRequired(source, before, after) {
  if (!source.includes(before)) throw new Error(`Smoke-test fixture marker not found: ${before}`);
  return source.replace(before, after);
}

try {
  const template = path.join(root, "templates", "learn-deck-polished-style.html");
  const directOut = path.join(workspace, "direct");
  fs.mkdirSync(directOut, { recursive: true });
  const directOutput = run("html_to_ppt.js", [
    "--input", template,
    "--out-dir", directOut,
    "--name", "direct",
    "--font-face", "Arial",
    "--no-preview",
  ]);
  const directPptx = path.join(directOut, "direct-editable.pptx");
  assertPptx(directPptx);
  const expectedSlides = (fs.readFileSync(template, "utf8").match(/<section class="slide"/g) || []).length;
  if (!directOutput.includes(`"slides": ${expectedSlides}`)) {
    throw new Error(`Direct conversion did not report the expected ${expectedSlides} slides.\n${directOutput}`);
  }
  const auditOutput = run("html_to_ppt.js", ["--input", template, "--dom-audit-only"]);
  for (const marker of ['"mode": "dom-audit-only"', '"issues": 0', '"text-contain": 10', '"icon-center": 3', '"chart-labels": 1']) {
    if (!auditOutput.includes(marker)) throw new Error(`DOM audit did not include ${marker}\n${auditOutput}`);
  }
  const slide3Xml = readZipMember(directPptx, "ppt/slides/slide3.xml");
  const centerName = slide3Xml.match(/name="[^"]*map-center[^"]*_text"/);
  const centerMarker = centerName ? centerName.index : -1;
  const centerStart = slide3Xml.lastIndexOf("<p:sp>", centerMarker);
  const centerEnd = slide3Xml.indexOf("</p:sp>", centerMarker);
  const centerXml = centerMarker >= 0 && centerStart >= 0 && centerEnd >= 0
    ? slide3Xml.slice(centerStart, centerEnd + "</p:sp>".length)
    : "";
  if (!/<a:t>Core<\/a:t>[\s\S]*?<\/a:p><a:p>[\s\S]*?<a:t>idea<\/a:t>/.test(centerXml)) {
    throw new Error("Centered multiline text was not written as separate PowerPoint paragraphs.");
  }

  let broken = fs.readFileSync(template, "utf8");
  broken = replaceRequired(broken, "grid-template-columns: 33px minmax(0, 1fr);", "grid-template-columns: 1px minmax(0, 1fr);");
  broken = replaceRequired(broken, "column-gap: 10px;", "column-gap: 0;");
  broken = replaceRequired(broken, "height: 104px;", "height: 56px;");
  const brokenFile = path.join(workspace, "broken-layout.html");
  fs.writeFileSync(brokenFile, broken, "utf8");
  const guardOutput = run("html_to_ppt.js", [
    "--input", brokenFile,
    "--out-dir", path.join(workspace, "broken"),
    "--name", "broken",
    "--no-preview",
  ], true);
  for (const marker of ["HTML DOM audit failed", '"type":"overlap"', '"type":"contain"']) {
    if (!guardOutput.includes(marker)) throw new Error(`Layout-guard failure did not include ${marker}\n${guardOutput}`);
  }

  const domAuditFixture = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; }
    .slide { position: relative; width: 1280px; height: 720px; overflow: hidden; font-family: Arial, sans-serif; }
    .off-slide { position: absolute; left: 1260px; top: 20px; width: 80px; height: 30px; background: #f66; }
    .clip { position: absolute; left: 50px; top: 50px; width: 70px; height: 22px; overflow: hidden; white-space: nowrap; font-size: 20px; }
    .wrap { position: absolute; left: 50px; top: 100px; width: 100px; font-size: 20px; }
    .icon { position: absolute; left: 250px; top: 50px; width: 80px; height: 80px; background: #eef; }
    .icon svg { position: absolute; left: 2px; top: 2px; width: 20px; height: 20px; }
    .chart { position: absolute; left: 380px; top: 50px; width: 180px; height: 140px; display: flex; }
    .series { width: 80px; height: 100px; }
    .circle { position: absolute; left: 620px; top: 50px; width: 80px; height: 80px; border-radius: 50%; display: flex; align-items: center; justify-content: center; text-align: center; white-space: nowrap; font-size: 18px; background: #4567ef; color: white; }
  </style></head><body><section class="slide">
    <div class="off-slide"></div>
    <div class="clip">This label is clipped</div>
    <div class="wrap" data-layout-guard="single-line">This title should wrap unexpectedly</div>
    <div class="icon" data-layout-guard="icon-center"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg></div>
    <div class="chart" data-layout-guard="chart-labels"><div class="series" data-chart-series></div></div>
    <div class="circle" data-layout-guard="text-contain text-center">A very long label</div>
  </section></body></html>`;
  const domAuditFile = path.join(workspace, "broken-dom-audit.html");
  fs.writeFileSync(domAuditFile, domAuditFixture, "utf8");
  const domAuditFailure = run("html_to_ppt.js", ["--input", domAuditFile, "--dom-audit-only"], true);
  for (const marker of ['"type":"slide-overflow"', '"type":"text-overflow"', '"type":"unexpected-wrap"', '"type":"icon-center-drift"', '"type":"chart-label-missing"', '"type":"ellipse-text-overflow"']) {
    if (!domAuditFailure.includes(marker)) throw new Error(`DOM-audit failure did not include ${marker}\n${domAuditFailure}`);
  }

  const legacyOut = path.join(workspace, "legacy");
  fs.mkdirSync(legacyOut, { recursive: true });
  run("generate_ppt.js", [
    "--slides", path.join(root, "examples", "slides.example.json"),
    "--out-dir", legacyOut,
    "--name", "legacy",
    "--no-preview",
  ]);
  assertPptx(path.join(legacyOut, "legacy-editable.pptx"));

  passed = true;
  console.log("LearnDeck smoke test passed: direct HTML, DOM audit, layout guards, multiline text, and legacy JSON.");
} catch (err) {
  console.error(err.stack || err.message || String(err));
  console.error(`Smoke-test artifacts kept at: ${workspace}`);
  process.exitCode = 1;
} finally {
  if (passed) fs.rmSync(workspace, { recursive: true, force: true });
}
