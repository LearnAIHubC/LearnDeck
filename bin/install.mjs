#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "learn-deck";
const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(dirname, "..");

function usage() {
  console.log(`LearnDeck installer

Usage:
  npx @learnaihubc/learn-deck [options]

Options:
  --force          Replace an existing LearnDeck skill installation
  --dest <dir>     Install into a custom skills directory
  --help           Show this help
`);
}

function parseArgs(argv) {
  const opts = { force: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    if (arg === "--dest") {
      if (i + 1 >= argv.length) throw new Error("Missing value for --dest");
      opts.dest = argv[++i];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function defaultSkillsDir() {
  return path.join(codexHome(), "skills");
}

function ensurePackageLooksLikeSkill() {
  const skillMd = path.join(packageRoot, "SKILL.md");
  if (!fs.existsSync(skillMd)) {
    throw new Error(`SKILL.md not found in package root: ${packageRoot}`);
  }
}

function isLearnDeckInstall(dir) {
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return false;
  const body = fs.readFileSync(skillMd, "utf8");
  return /^name:\s*learn-deck\s*$/m.test(body);
}

function copyEntry(name, destRoot) {
  const src = path.join(packageRoot, name);
  const dest = path.join(destRoot, name);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: false });
}

function install(opts) {
  ensurePackageLooksLikeSkill();
  const skillsDir = path.resolve(opts.dest || defaultSkillsDir());
  const dest = path.join(skillsDir, SKILL_NAME);
  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(dest)) {
    if (!isLearnDeckInstall(dest)) {
      throw new Error(`Destination exists and does not look like LearnDeck: ${dest}`);
    }
    if (!opts.force) {
      console.log(`LearnDeck is already installed at ${dest}`);
      console.log("Run again with --force to replace it with this package version.");
      return;
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.mkdirSync(dest, { recursive: true });
  for (const name of [
    "SKILL.md",
    "README.md",
    "README.en.md",
    "README.zh-CN.md",
    "LICENSE.txt",
    "agents",
    "assets",
    "examples",
    "scripts",
    "templates",
  ]) {
    copyEntry(name, dest);
  }

  console.log(`LearnDeck installed to ${dest}`);
  console.log("Restart Codex, then use $learn-deck to generate PPTs from learning content.");
}

try {
  install(parseArgs(process.argv));
} catch (err) {
  console.error(`LearnDeck install failed: ${err.message || err}`);
  process.exit(1);
}
