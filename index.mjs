#!/usr/bin/env node
/**
 * inline-local-images.mjs  —  v2.0
 * Inlines <img src> and srcset entries into data: URLs.
 * - Now supports http(s): and protocol-relative // URLs (downloads & inlines).
 * - Skips existing data: URLs.
 * - URL-decodes %XX in local paths; strips ?query/#hash for local lookups.
 * - Case-insensitive fallback resolution across path segments (locals).
 * - Warns once per missing/too-large/unreadable/failed-remote file.
 * - Resolves locals relative to input file dir, or --root.
 *
 * Usage:
 *   node inline-local-images.mjs <input.html> [-o output.html] [--root DIR] [--maxMB 10]
 */

import fs from "fs";
import path from "path";
import url from "url";
import http from "http";
import https from "https";

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

function isDataUrl(src) {
  return /^data:/i.test(src);
}

function isRemote(src) {
  return /^(https?:|\/\/)/i.test(src);
}

function normalizeRemoteUrl(u) {
  return u.startsWith("//") ? "https:" + u : u;
}

function decodeMaybeURI(p) {
  try { return decodeURI(p); } catch { return p; }
}

function stripQueryHash(p) {
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
  if (rawSrc.startsWith("file://")) {
    try { return url.fileURLToPath(rawSrc); } catch { /* fall through */ }
  }

  const decoded = decodeMaybeURI(rawSrc);
  const noQH = stripQueryHash(decoded);

  const candidate = path.resolve(baseDir, noQH);
  if (fs.existsSync(candidate)) return candidate;

  const norm = path.normalize(noQH);
  const parts = norm.split(/[\\/]+/).filter(Boolean);
  let cur = path.resolve(baseDir);

  for (const part of parts) {
    if (!fs.existsSync(cur) || !fs.statSync(cur).isDirectory()) {
      return candidate;
    }
    const entries = fs.readdirSync(cur);
    const matched = entries.find(e => e.toLowerCase() === part.toLowerCase());
    cur = path.join(cur, matched || part);
  }
  return cur;
}

function bufferToDataUrl(buf, fallbackPathOrExt, contentTypeHeader) {
  let mime = null;

  // Prefer server-provided content-type if present and looks like image/*
  if (contentTypeHeader && /^image\/[a-z0-9.+-]+/i.test(contentTypeHeader)) {
    mime = contentTypeHeader.split(";")[0].trim();
  }

  // Fallback to extension
  if (!mime && fallbackPathOrExt) {
    const ext = (fallbackPathOrExt.includes(".")
      ? path.extname(fallbackPathOrExt).slice(1)
      : fallbackPathOrExt
    ).toLowerCase();
    mime = extsToMime[ext] || null;
  }

  if (!mime) mime = "application/octet-stream";
  const base64 = Buffer.from(buf).toString("base64");
  return `data:${mime};base64,${base64}`;
}

function toDataUrlLocal(filePath, maxBytes) {
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

  return { ok: true, dataUrl: bufferToDataUrl(buf, filePath) };
}

// ---- Remote fetching (http/https) with redirects and hard size cap ----
async function fetchRemoteBuffer(u, maxBytes, { timeoutMs = 15000, maxRedirects = 5 } = {}) {
  const visited = new Set();

  async function doFetch(currentUrl, redirectsLeft) {
    if (visited.has(currentUrl)) throw new Error("redirect_loop");
    visited.add(currentUrl);

    const uObj = new URL(currentUrl);
    const mod = uObj.protocol === "http:" ? http : https;

    return new Promise((resolve, reject) => {
      const req = mod.get({
        protocol: uObj.protocol,
        hostname: uObj.hostname,
        port: uObj.port,
        path: uObj.pathname + uObj.search,
        headers: {
          "User-Agent": "inline-local-images/2.0 (+https://example.invalid)",
          "Accept": "*/*",
          "Accept-Encoding": "identity"
        },
        timeout: timeoutMs
      }, (res) => {
        const { statusCode = 0, headers } = res;

        // Handle redirects
        if ([301,302,303,307,308].includes(statusCode)) {
          res.resume(); // drain
          const loc = headers.location;
          if (!loc) return reject(new Error("redirect_without_location"));
          if (redirectsLeft <= 0) return reject(new Error("too_many_redirects"));
          const next = new URL(loc, currentUrl).toString();
          doFetch(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          return reject(new Error(`http_${statusCode}`));
        }

        const cl = headers["content-length"] ? parseInt(headers["content-length"], 10) : null;
        if (Number.isFinite(cl) && cl > maxBytes) {
          res.resume();
          const err = new Error("too_large");
          err.size = cl;
          return reject(err);
        }

        const chunks = [];
        let total = 0;

        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy(new Error("too_large_stream"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: headers["content-type"] || null }));
        res.on("error", reject);
      });

      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    });
  }

  return doFetch(u, maxRedirects);
}

async function toDataUrlRemote(remoteUrl, maxBytes) {
  const normalized = normalizeRemoteUrl(remoteUrl);
  try {
    const { buffer, contentType } = await fetchRemoteBuffer(normalized, maxBytes);
    return { ok: true, dataUrl: bufferToDataUrl(buffer, path.extname(new URL(normalized).pathname).slice(1), contentType) };
  } catch (e) {
    const reasonMap = {
      timeout: "remote_timeout",
      redirect_loop: "remote_redirect_loop",
      redirect_without_location: "remote_redirect_no_location",
      too_many_redirects: "remote_too_many_redirects",
      too_large: "too_large",
      too_large_stream: "too_large",
    };
    const msg = String(e?.message || "");
    const httpMatch = msg.startsWith("http_") ? "remote_http_error" : null;
    const reason = reasonMap[msg] || httpMatch || "remote_error";
    const out = { ok: false, reason };
    if (e?.size) out.size = e.size;
    return out;
  }
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
    too_large:  `File too large${resOrMsg.size ? ` (${resOrMsg.size} bytes)` : ""}`,
    read_error: `Read error: ${resOrMsg.err?.message || "unknown"}`,
    remote_timeout: `Remote timeout`,
    remote_redirect_loop: `Remote redirect loop`,
    remote_redirect_no_location: `Remote redirect without Location`,
    remote_too_many_redirects: `Too many redirects`,
    remote_http_error: `Remote HTTP error`,
    remote_error: `Remote fetch error`,
  };
  console.error(`[warn] ${key} → ${reasons[resOrMsg.reason] || resOrMsg.reason}`);
}

// cache for remote URLs within this run
const remoteCache = new Map(); // url -> Promise<{ok, dataUrl}|{ok:false,...}>

async function transformSrcsetValue(srcset, baseDir, maxBytes) {
  const parts = srcset.split(",").map(s => s.trim()).filter(Boolean);
  const out = [];

  for (const part of parts) {
    const match = part.match(/^(\S+)(\s+\S+)?$/);
    if (!match) { out.push(part); continue; }

    const urlPart = match[1];
    const descriptor = (match[2] || "").trim();

    if (isDataUrl(urlPart)) { out.push(part); continue; }

    // remote?
    if (isRemote(urlPart)) {
      const key = `remote:${urlPart}`;
      const p = remoteCache.get(urlPart) || toDataUrlRemote(urlPart, maxBytes);
      remoteCache.set(urlPart, p);
      const res = await p;
      if (res.ok) out.push(descriptor ? `${res.dataUrl} ${descriptor}` : res.dataUrl);
      else { warnOnce(`srcset:${urlPart}`, res); out.push(part); }
      continue;
    }

    // local file
    const resolved = resolveLocalPath(urlPart, baseDir);
    const res = toDataUrlLocal(resolved, maxBytes);
    if (res.ok) {
      out.push(descriptor ? `${res.dataUrl} ${descriptor}` : res.dataUrl);
    } else {
      warnOnce(`srcset:${urlPart}`, res);
      out.push(part);
    }
  }
  return out.join(", ");
}

async function transformImgTag(tag, baseDir, maxBytes, counters) {
  let changed = tag;

  // src=
  const src = getAttrFromTag(tag, "src");
  if (src && !isDataUrl(src)) {
    if (isRemote(src)) {
      const p = remoteCache.get(src) || toDataUrlRemote(src, maxBytes);
      remoteCache.set(src, p);
      const res = await p;
      if (res.ok) {
        changed = replaceAttrInTag(changed, "src", res.dataUrl, src);
        counters.replacedCount++;
      } else {
        warnOnce(`src:${src}`, res);
      }
    } else {
      const resolved = resolveLocalPath(src, baseDir);
      const res = toDataUrlLocal(resolved, maxBytes);
      if (res.ok) {
        changed = replaceAttrInTag(changed, "src", res.dataUrl, src);
        counters.replacedCount++;
      } else {
        warnOnce(`src:${src}`, res);
      }
    }
  }

  // srcset=
  const srcset = getAttrFromTag(tag, "srcset");
  if (srcset) {
    const newVal = await transformSrcsetValue(srcset, baseDir, maxBytes);
    if (newVal !== srcset) {
      changed = replaceAttrInTag(changed, "srcset", newVal, srcset);
      counters.srcsetCount++;
    }
  }

  return changed;
}

async function processHtml(html, baseDir, maxBytes, counters) {
  const re = /<img\b[^>]*>/gi;
  let last = 0;
  let out = "";

  const matches = [...html.matchAll(re)];
  for (const m of matches) {
    const idx = m.index ?? 0;
    out += html.slice(last, idx);
    const tag = m[0];
    const newTag = await transformImgTag(tag, baseDir, maxBytes, counters);
    out += newTag;
    last = idx + tag.length;
  }
  out += html.slice(last);
  return out;
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

const counters = { replacedCount: 0, srcsetCount: 0 };

(async () => {
  const outHtml = await processHtml(html, baseDir, MAX_BYTES, counters);

  if (output) {
    if (path.resolve(output) === inputPath) {
      console.error(`[error] Refusing to overwrite input. Choose a different -o.`);
      process.exit(3);
    }
    try {
      fs.writeFileSync(output, outHtml, "utf8");
    } catch (e) {
      console.error(`[error] Could not write ${output}: ${e.message}`);
      process.exit(4);
    }
    console.error(`[info] Inlined ${counters.replacedCount} src image(s), updated ${counters.srcsetCount} srcset(s) → ${output}`);
  } else {
    process.stdout.write(outHtml);
    console.error(`\n[info] Inlined ${counters.replacedCount} src image(s), updated ${counters.srcsetCount} srcset(s) → stdout`);
  }
})().catch((e) => {
  console.error(`[error] Unexpected failure: ${e?.stack || e}`);
  process.exit(5);
});
