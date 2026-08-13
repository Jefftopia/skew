# Putting a CDN in front of the Braid gateway

Short version: **cache `/__braid/frag/*` and `/__braid/realm/*` aggressively, and don't edge-cache
pierced pages.** No custom cache keys, no `Vary` configuration, nothing your CDN has to support
beyond ordinary URL-keyed caching.

That is only true because the protocol was designed for it. If you are curious why, or you want
to cache pages too, read on.

---

## Why it's this simple

Each kind of thing the gateway serves has its own path, rather than one path that returns
different content depending on request headers:

| Path | Serves | How to cache it |
| --- | --- | --- |
| `/__braid/frag/:id/*` | the fragment's own endpoint: JS, CSS, images, data | **Aggressively.** This is the bulk of your traffic. If the fragment's build hashes filenames, cache immutably; the fragment id is in the path, so two fragments' assets can never collide. |
| `/__braid/realm/:id/*` | the realm stub each fragment's hidden iframe boots from | **Aggressively.** Tiny, identical for a given URL, already marked `max-age=3600, stale-while-revalidate`. Caching it removes a round trip from every fragment boot. |
| `/__braid/doc/:id/*` | the fragment's document, prepared for the host page's DOM | **Follow the fragment's own headers.** It is the fragment team's call, and it often reflects a signed-in user. |
| `/__braid/registry` | the discovery listing, if enabled | **Never.** Already `no-store`; it depends on who asked. |

None of these vary on a request header. A CDN that does nothing but key on the URL is correct.

**Note if you are upgrading from protocol v1:** realm stubs used to live at `/__braid/frag/*`
behind `sec-fetch-dest: iframe`, and prepared documents behind an `x-braid-dest` header. Both now
have their own paths, and the header is gone. Any cache-key rules you wrote for those can go.

---

## The one URL that does vary

A page URL that some fragment declares in its `pierce` list returns:

- the shell **with fragments composed into it**, for a document navigation
  (`sec-fetch-dest: document`);
- the plain shell, for anything else — a client-side router prefetching the same URL, say.

That variance is inherent: those are genuinely different things to ask for, and we don't control
what a host's router fetches. The gateway sends `Vary: sec-fetch-dest` on them.

**The simple answer is not to cache them.** Composed pages are usually personalized anyway (the
gateway forwards cookies to fragment endpoints), and composition couples lifetimes — a cached
composed page freezes the fragment's HTML at the shell's TTL, so a fragment deploy stays invisible
until the page expires.

If your pages are genuinely anonymous and you want them cached, then — and only then — you need
`sec-fetch-dest` in the cache key for those routes, because most CDNs (Cloudflare among them)
honor `Vary` only for `Accept-Encoding`. Use a short TTL with `stale-while-revalidate`, and
confirm the edge does not strip `Sec-*` request headers before they reach the origin.

---

## Behaviors to preserve at the edge

**Streaming.** Piercing interleaves the shell and the fragment as they arrive, so the shell's
first bytes reach the browser before the fragment finishes rendering. A CDN that buffers whole
responses erases that. Enable streaming/chunked pass-through for composed documents.

**Compression.** The gateway rewrites bodies and drops `content-length`/`content-encoding` on
transformed responses. Compress at the edge rather than expecting the origin to.

**Frame headers.** The realm is a same-origin iframe. If your CDN or WAF injects
`X-Frame-Options: DENY` or a restrictive `frame-ancestors` on `/__braid/realm/*`, every fragment
fails to boot with a `realm-boot` error. Exempt the braid namespaces, or scope those headers to
`SAMEORIGIN`.

---

## Content Security Policy

- `frame-src 'self'` is required — the compat realm is a same-origin iframe.
- Add `blob:` only if you use contract-blob realms.
- Fragment scripts load from your own origin under `/__braid/frag/…`, so `script-src 'self'`
  covers them with no per-fragment entries.

---

## Verifying your configuration

Run these against the edge, not the origin.

```bash
# 1. braid URLs must not vary on anything (expect no Vary header)
curl -sI https://edge/__braid/realm/billing/ | grep -i vary
curl -sI https://edge/__braid/frag/billing/main.js | grep -i vary
```

```bash
# 2. the same braid URL returns the same body however it is asked for
curl -s                            https://edge/__braid/realm/billing/ | shasum
curl -s -H 'sec-fetch-dest: iframe' https://edge/__braid/realm/billing/ | shasum
```

```bash
# 3. a document navigation is composed; a soft-navigation fetch of the same page is not
curl -s -H 'sec-fetch-dest: document' https://edge/billing/invoices | grep -c shadowrootmode  # 1
curl -s -H 'sec-fetch-dest: empty'    https://edge/billing/invoices | grep -c shadowrootmode  # 0
```

(1) and (2) failing means something at the edge is adding variance Braid did not ask for. (3)
returning the same count twice means pierced pages are being cached without `sec-fetch-dest` in
the key — stop caching them, or add it.
