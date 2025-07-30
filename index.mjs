#!/usr/bin/env node
/**
 * inline-local-images.mjs  —  v1.1
 * Inlines local <img src> and srcset entries into data: URLs.
 * - Skips data:, http(s):, and protocol-relative // URLs.
 * - URL-decodes %XX in paths (handles %20 spaces, etc).
 * - Strips ?query and #hash for local file lookups.
 * - Case-insensitive fallback resolution across path segments.
 * - Warns once per missing/too-large file.
 * - Resolves relative to input file dir, or --root.
 *
 * Usage:
 *   node inline-local-images.mjs <input.html> [-o output.html] [--root DIR] [--maxMB 10]
 */

import fs from "fs";
import path from "path";
import url from "url";

const extsToMime = {
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  gif:  "image/gif",
  webp: "image/webp",
  bmp:  "image/bmp",
  ico:  "image/x-icon",
  svg:  "image/svg+xml",
  avif: "image/avif"
};

function usageAndExit() {
  console.error(`Usage: node inline-local-images.mjs <input.html> [-o output.html] [--root DIR] [--maxMB 10]`);
  process.exit(1);
}

function isRemoteOrData(src) {
  return /^(data:|https?:|\/\/)/i.test(src);
}

function decodeMaybeURI(p) {
  try { return decodeURI(p); } catch { return p; }
}

function stripQueryHash(p) {
  // remove ?query and #hash (for local filesystem paths)
  const iQ = p.indexOf("?");
  const iH = p.indexOf("#");
  const cut = Math.min(iQ === -1 ? p.length : iQ, iH === -1 ? p.length : iH);
  return p.slice(0, cut);
}

/**
 * Resolve a local path robustly:
 * - handles file:// URLs
 * - URL-decodes percent escapes
 * - strips ?query/#hash
 * - if not found, tries case-insensitive traversal segment-by-segment
 */
function resolveLocalPath(rawSrc, baseDir) {
  // file:// URL?
  if (rawSrc.startsWith("file://")) {
    try { return url.fileURLToPath(rawSrc); } catch { /* fall through */ }
  }

  const decoded = decodeMaybeURI(rawSrc);
  const noQH = stripQueryHash(decoded);

  // Resolve relative to baseDir
  const candidate = path.resolve(baseDir, noQH);
  if (fs.existsSync(candidate)) return candidate;

  // Case-insensitive fallback: walk each segment
  const norm = path.normalize(noQH);
  const parts = norm.split(/[\\/]+/).filter(Boolean);
  let cur = path.resolve(baseDir);

  for (const part of parts) {
    if (!fs.existsSync(cur) || !fs.statSync(cur).isDirectory()) {
      // base directory missing; return the best-effort candidate
      return candidate;
    }
    const entries = fs.readdirSync(cur);
    const matched = entries.find(e => e.toLowerCase() === part.toLowerCase());
    cur = path.join(cur, matched || part);
  }
  return cur; // may or may not exist; caller checks
}

function toDataUrl(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: "not_found" };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { ok: false, reason: "not_file" };
  if (stat.size > maxBytes) return { ok: false, reason: "too_large", size: stat.size };

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return { ok: false, reason: "read_error", err: e };
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = extsToMime[ext] || "application/octet-stream";
  const base64 = buf.toString("base64");
  return { ok: true, dataUrl: `data:${mime};base64,${base64}` };
}

function replaceAttrInTag(tag, attr, newValue, originalValue) {
  const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "i");
  return tag.replace(re, (m, _full, d1, d2, d3) => {
    const quote = m.includes('"') ? '"' : (m.includes("'") ? "'" : '"');
    const old = d1 ?? d2 ?? d3 ?? originalValue;
    return m.replace(old, newValue).replace(/=(\s*)(["'])?[^"']*?(["'])?/, `=$1${quote}${newValue}${quote}`);
  });
}

function getAttrFromTag(tag, attr = "src") {
  const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

function transformSrcsetValue(srcset, baseDir, maxBytes, warnOnce) {
  const parts = srcset.split(",").map(s => s.trim()).filter(Boolean);
  const out = [];

  for (const part of parts) {
    const match = part.match(/^(\S+)(\s+\S+)?$/);
    if (!match) { out.push(part); continue; }

    const urlPart = match[1];
    const descriptor = (match[2] || "").trim();

    if (isRemoteOrData(urlPart)) { out.push(part); continue; }

    const resolved = resolveLocalPath(urlPart, baseDir);
    const res = toDataUrl(resolved, maxBytes);
    if (res.ok) {
      out.push(descriptor ? `${res.dataUrl} ${descriptor}` : res.dataUrl);
    } else {
      warnOnce(`srcset:${urlPart}`, res);
      out.push(part);
    }
  }
  return out.join(", ");
}

// ---- CLI ----
const args = process.argv.slice(2);
if (!args[0]) usageAndExit();

let input = args[0];
let output = null;
let root = null;
let maxMB = 10;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "-o") output = args[++i];
  else if (a === "--root") root = args[++i];
  else if (a === "--maxMB") maxMB = parseFloat(args[++i]);
  else if (a === "--help" || a === "-h") usageAndExit();
}

const inputPath = path.resolve(process.cwd(), input);
const baseDir = root ? path.resolve(process.cwd(), root) : path.dirname(inputPath);
const MAX_BYTES = Math.floor((maxMB || 10) * 1024 * 1024);

let html;
try {
  html = fs.readFileSync(inputPath, "utf8");
} catch (e) {
  console.error(`[error] Could not read ${inputPath}: ${e.message}`);
  process.exit(2);
}

// Warn-once helper
const seenWarn = new Set();
function warnOnce(key, resOrMsg) {
  if (seenWarn.has(key)) return;
  seenWarn.add(key);
  if (typeof resOrMsg === "string") {
    console.error(`[warn] ${resOrMsg}`);
    return;
  }
  const reasons = {
    not_found:  `File not found`,
    not_file:   `Not a file`,
    too_large:  `File too large (${resOrMsg.size} bytes)`,
    read_error: `Read error: ${resOrMsg.err?.message || "unknown"}`
  };
  // key can include context like "src:<path>" or "srcset:<entry>"
  console.error(`[warn] ${key} → ${reasons[resOrMsg.reason] || resOrMsg.reason}`);
}

let replacedCount = 0;
let srcsetCount = 0;

const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
  let changed = tag;

  // src=
  const src = getAttrFromTag(tag, "src");
  if (src && !isRemoteOrData(src)) {
    const resolved = resolveLocalPath(src, baseDir);
    const res = toDataUrl(resolved, MAX_BYTES);
    if (res.ok) {
      changed = replaceAttrInTag(changed, "src", res.dataUrl, src);
      replacedCount++;
    } else {
      warnOnce(`src:${src}`, res);
    }
  }

  // srcset=
  const srcset = getAttrFromTag(tag, "srcset");
  if (srcset) {
    const newVal = transformSrcsetValue(srcset, baseDir, MAX_BYTES, warnOnce);
    if (newVal !== srcset) {
      changed = replaceAttrInTag(changed, "srcset", newVal, srcset);
      srcsetCount++;
    }
  }

  return changed;
});

if (output) {
  if (path.resolve(output) === inputPath) {
    console.error(`[error] Refusing to overwrite input. Choose a different -o.`);
    process.exit(3);
  }
  try {
    fs.writeFileSync(output, out, "utf8");
  } catch (e) {
    console.error(`[error] Could not write ${output}: ${e.message}`);
    process.exit(4);
  }
  console.error(`[info] Inlined ${replacedCount} src image(s), updated ${srcsetCount} srcset(s) → ${output}`);
} else {
  process.stdout.write(out);
  console.error(`\n[info] Inlined ${replacedCount} src image(s), updated ${srcsetCount} srcset(s) → stdout`);
}

