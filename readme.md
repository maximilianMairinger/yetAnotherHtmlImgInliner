

# Yet Another HTML Img Inliner

Inline every **local** `<img src>` (and `srcset` entries) in an HTML file into base‑64 `data:` URLs – no remote fetching, zero dependencies.

```bash
npx -y yet-another-html-img-inliner input.html -o output.inlined.html
````

---

## Why another inliner?

* **Local‑only by design** – it never hits the network.
* Handles **`srcset`** as well as `src`.
* Understands URL‑encoded paths (e.g. `%20` for spaces) & strips `?query#hash`.
* Case‑insensitive fallback (useful on Windows / mixed‑case exports).
* Size guard (`--maxMB`, default 10 MB per image).
* Single ≈300‑line script, no runtime deps—perfect for one‑off builds or CI.

---

## Install / Run

| use‑case                  | command                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **one‑off (recommended)** | `npx -y yet-another-html-img-inliner input.html -o output.html`                                    |
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

---

## Caveats

* Adds \~33 % size overhead (base64). Heavy pages can balloon quickly.
* Only PNG, JPEG, GIF, SVG, WebP, BMP, ICO & AVIF are recognised. Others fall back to `application/octet-stream`.
* Skips `data:`, `http(s):` and protocol‑relative (`//…`) sources untouched.
* Refuses to overwrite the input file; choose a different `-o`.

---

