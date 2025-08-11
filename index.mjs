#!/usr/bin/env node
/**
 * inline-local-images.mjs
 *
 * Inlines <img src> and srcset entries into base64 data: URLs.
 * - Local files (with robust resolution) and remote URLs (http/https + //).
 * - Skips data: URLs.
 * - URL-decodes local paths; strips ?query/#hash; case-insensitive traversal fallback.
 * - Enforces --maxMB for local and remote (honors Content-Length; hard cutoff when streaming).
 * - Caches repeated remote URLs in a single run.
 * - Uses Cheerio to preserve the original HTML structure/attributes/whitespace.
 *
 * Usage:
 *   node inline-local-images.mjs <input.html> [-o output.html] [--root DIR] [--maxMB 10]
 */

import fs from "fs";
import path from "path";
import url from "url";
import http from "http";
import https from "https";
import * as cheerio from "cheerio";

// ---------------- MIME map ----------------
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

// ---------------- CLI helpers ----------------
function usageAndExit() {
  console.error(`Usage: node inline-local-images.mjs <input.html> [-o output.html] [--root DIR] [--maxMB 10]`);
  process.exit(1);
}

// ---------------- general helpers ----------------
const isDataUrl = (s) => /^data:/i.test(s);
const isRemote  = (s) => /^(https?:|\/\/)/i.test(s);
const normalizeRemoteUrl = (u) => u.startsWith("//") ? "https:" + u : u;

function decodeMaybeURI(p) { try { return decodeURI(p); } catch { return p; } }
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
  if (!rawSrc) return rawSrc;

  if (rawSrc.startsWith("file://")) {
    try { return url.fileURLToPath(rawSrc); } catch { /* fall through */ }
  }

  const decoded = decodeMaybeURI(rawSrc);
  const noQH = stripQueryHash(decoded);

  const candidate = path.resolve(baseDir, noQH);
  if (fs.existsSync(candidate)) return candidate;

  // Case-insensitive traversal
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

  // Prefer HTTP header when it looks like an image
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
  return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

// ---------------- local to data URL ----------------
function toDataUrlLocal(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: "not_found" };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { ok: false, reason: "not_file" };
  if (stat.size > maxBytes) return { ok: false, reason: "too_large", size: stat.size };
  try {
    const buf = fs.readFileSync(filePath);
    return { ok: true, dataUrl: bufferToDataUrl(buf, filePath) };
  } catch (e) {
    return { ok: false, reason: "read_error", err: e };
  }
}

// ---------------- remote fetch with limits ----------------
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
          "User-Agent": "inline-local-images/3.0",
          "Accept": "*/*",
          "Accept-Encoding": "identity"
        },
        timeout: timeoutMs
      }, (res) => {
        const { statusCode = 0, headers } = res;

        // Redirects
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
    const ext = path.extname(new URL(normalized).pathname).slice(1);
    return { ok: true, dataUrl: bufferToDataUrl(buffer, ext, contentType) };
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
    const reason = msg.startsWith("http_") ? "remote_http_error" : (reasonMap[msg] || "remote_error");
    const out = { ok: false, reason };
    if (e?.size) out.size = e.size;
    return out;
  }
}

// ---------------- warnings ----------------
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

// ---------------- srcset parsing ----------------
/**
 * Split a srcset string into item strings (handles simple cases).
 * Note: The formal grammar is complex; this covers typical usage (no URLs with unescaped commas).
 */
function splitSrcset(srcset) {
  // Keep it simple: split on commas, trim each
  return srcset.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Parse one srcset item into { url, descriptor }.
 * Example items: "image-1x.png 1x", "image-100w.png 100w", "image.png"
 */
function parseSrcsetItem(item) {
  const m = item.match(/^(\S+)(\s+\S+)?$/);
  if (!m) return { url: null, descriptor: null, raw: item };
  const url = m[1];
  const descriptor = (m[2] || "").trim() || null;
  return { url, descriptor, raw: item };
}

// ---------------- main HTML processing (Cheerio) ----------------
async function processHtmlWithCheerio(html, baseDir, maxBytes, counters) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const remoteCache = new Map(); // url -> Promise<{ok,dataUrl}|{ok:false,...}>

  const inlineUrl = async (rawUrl, warnCtx) => {
    if (!rawUrl || isDataUrl(rawUrl)) return rawUrl;

    if (isRemote(rawUrl)) {
      const promise = remoteCache.get(rawUrl) || toDataUrlRemote(rawUrl, maxBytes);
      remoteCache.set(rawUrl, promise);
      const res = await promise;
      if (res.ok) { counters.replacedCount++; return res.dataUrl; }
      warnOnce(`${warnCtx}:${rawUrl}`, res);
      return rawUrl;
    }

    const resolved = resolveLocalPath(rawUrl, baseDir);
    const res = toDataUrlLocal(resolved, maxBytes);
    if (res.ok) { counters.replacedCount++; return res.dataUrl; }
    warnOnce(`${warnCtx}:${rawUrl}`, res);
    return rawUrl;
  };

  const imgs = $("img");
  for (const el of imgs) {
    const $el = $(el);

    // src
    const oldSrc = $el.attr("src");
    if (oldSrc) {
      const newSrc = await inlineUrl(oldSrc, "src");
      if (newSrc !== oldSrc) $el.attr("src", newSrc);
    }

    // srcset
    const oldSrcset = $el.attr("srcset");
    if (oldSrcset) {
      const items = splitSrcset(oldSrcset);
      let changed = false;
      const newItems = [];
      for (const item of items) {
        const { url: partUrl, descriptor, raw } = parseSrcsetItem(item);
        if (!partUrl) { newItems.push(raw); continue; }
        const newUrl = await inlineUrl(partUrl, "srcset");
        if (newUrl !== partUrl) changed = true;
        newItems.push(descriptor ? `${newUrl} ${descriptor}` : newUrl);
      }
      if (changed) {
        $el.attr("srcset", newItems.join(", "));
        counters.srcsetCount++;
      }
    }
  }

  return $.html();
}

// ---------------- CLI entrypoint ----------------
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
  const outHtml = await processHtmlWithCheerio(html, baseDir, MAX_BYTES, counters);

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
