
# Yet Another HTML Img Inliner

Inline every `<img src>` (and `srcset` entries) in an HTML file into base-64 `data:` URLs – works for both **local files** and **remote images** – zero dependencies.

```bash
npx -y yet-another-html-img-inliner input.html -o output.inlined.html
````

---

## What’s new in v2.0?

* **Remote support** – downloads `http(s):` and protocol-relative (`//…`) images and inlines them.
* Skips existing `data:` URLs.
* Respects the same `--maxMB` size guard for remote and local images.
* Caches repeated remote URLs to avoid multiple downloads.
* All the previous local-handling goodness remains.

---

## Why another inliner?

* **Local + remote support** – embed assets from your filesystem *and* from the web.
* Handles **`srcset`** as well as `src`.
* Understands URL-encoded paths (e.g. `%20` for spaces) & strips `?query#hash`.
* Case-insensitive fallback for local files (useful on Windows / mixed-case exports).
* Size guard (`--maxMB`, default 10 MB per image) applies to both local and remote sources.
* Single \~500-line script, no runtime deps—perfect for one-off builds or CI.

---

## Install / Run

| use-case                  | command                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **one-off (recommended)** | `npx -y yet-another-html-img-inliner input.html -o output.html`                                    |
| global                    | `npm i -g yet-another-html-img-inliner` → `yet-another-html-img-inliner input.html -o output.html` |
| project dep               | `npm i --save-dev yet-another-html-img-inliner` → add it to your build scripts                     |

---

## CLI

```bash
yet-another-html-img-inliner <input.html> [-o output.html] [--root DIR] [--maxMB 10]

Options:
  -o           Write result to file (omit to pipe to stdout)
  --root DIR   Resolve relative image paths from DIR instead of input file’s folder
  --maxMB N    Skip images larger than N megabytes (default: 10)
  -h, --help   Show this help
```

### Examples

Inline and overwrite (guarded):

```bash
yet-another-html-img-inliner src/index.html -o dist/index.html
```

Pipe to stdout:

```bash
yet-another-html-img-inliner email.html > email.embedded.html
```

Images live in a sibling folder:

```bash
yet-another-html-img-inliner build/page.html --root build/assets -o build/page.inline.html
```

Remote images too:

```bash
yet-another-html-img-inliner newsletter.html -o newsletter.inline.html
```

---

## Caveats

* Adds \~33 % size overhead (base64). Heavy pages can balloon quickly.
* Only PNG, JPEG, GIF, SVG, WebP, BMP, ICO & AVIF are recognised. Others fall back to `application/octet-stream`.
* Skips `data:` URLs (already inline).
* For remote images:

  * Follows up to 5 redirects.
  * Aborts downloads exceeding `--maxMB` limit.
  * Requires network access at runtime.
* Refuses to overwrite the input file; choose a different `-o`.

---

```

Do you want me to also add an **“Advanced”** section to the README describing the redirect, timeout, and caching behavior of remote inlining? That could make the new behavior crystal-clear.
