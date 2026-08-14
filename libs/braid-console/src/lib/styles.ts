/**
 * The console's styles, as a string injected once at mount.
 *
 * Two constraints drive every choice here, both from being a *library* that mounts inside someone
 * else's page:
 *
 * 1. **Every rule is scoped under `.braid-console`.** No resets, no bare element selectors, no
 *    `:root`. A library that styles `body` or `*` vandalizes its host, and the damage shows up in
 *    a part of the app nobody connects to this component.
 * 2. **Everything themable is a custom property on the scope class**, so a host restyles by
 *    setting variables rather than escalating specificity. Dark mode follows
 *    `prefers-color-scheme`, and a host that knows better can force it with `data-theme` — which
 *    must win in *both* directions, since an admin shell may be dark inside a light OS.
 *
 * Shipped as a string rather than a `.css` import so the library has no build-tool requirements:
 * a consumer bundling this needs no CSS loader, no `?inline` suffix, and no side-effect import
 * they can forget.
 */
export const CONSOLE_STYLES = `
.braid-console {
  --bc-bg: #ffffff;
  --bc-surface: #f7f8fa;
  --bc-border: #e2e5ea;
  --bc-text: #16191d;
  --bc-muted: #5c6470;
  --bc-accent: #2f5bd8;
  --bc-warn-bg: #fff7e6;
  --bc-warn-text: #7a4d00;
  --bc-warn-border: #f0d8a8;
  --bc-ok: #1a7f4b;
  --bc-err: #b3261e;
  --bc-radius: 6px;
  --bc-gap: 12px;
  --bc-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --bc-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  color: var(--bc-text);
  background: var(--bc-bg);
  font-family: var(--bc-font);
  font-size: 14px;
  line-height: 1.45;
  container-type: inline-size;
}

@media (prefers-color-scheme: dark) {
  .braid-console {
    --bc-bg: #14171b;
    --bc-surface: #1c2027;
    --bc-border: #2b313a;
    --bc-text: #e8eaed;
    --bc-muted: #99a1ad;
    --bc-accent: #7ea2ff;
    --bc-warn-bg: #2e2513;
    --bc-warn-text: #f0c674;
    --bc-warn-border: #4d3f1d;
    --bc-ok: #5fd39b;
    --bc-err: #f2836f;
  }
}

/* An explicit host choice wins over the OS in both directions. */
.braid-console[data-theme='light'] {
  --bc-bg: #ffffff; --bc-surface: #f7f8fa; --bc-border: #e2e5ea;
  --bc-text: #16191d; --bc-muted: #5c6470; --bc-accent: #2f5bd8;
  --bc-warn-bg: #fff7e6; --bc-warn-text: #7a4d00; --bc-warn-border: #f0d8a8; --bc-ok: #1a7f4b; --bc-err: #b3261e;
}
.braid-console[data-theme='dark'] {
  --bc-bg: #14171b; --bc-surface: #1c2027; --bc-border: #2b313a;
  --bc-text: #e8eaed; --bc-muted: #99a1ad; --bc-accent: #7ea2ff;
  --bc-warn-bg: #2e2513; --bc-warn-text: #f0c674; --bc-warn-border: #4d3f1d; --bc-ok: #5fd39b; --bc-err: #f2836f;
}

.braid-console *, .braid-console *::before, .braid-console *::after { box-sizing: border-box; }

.braid-console__header {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--bc-gap);
  padding-bottom: var(--bc-gap); border-bottom: 1px solid var(--bc-border); margin-bottom: var(--bc-gap);
}
.braid-console__title { font-size: 15px; font-weight: 600; margin: 0; }
.braid-console__count { color: var(--bc-muted); font-variant-numeric: tabular-nums; }
.braid-console__spacer { margin-left: auto; }

.braid-console__search {
  font: inherit; color: inherit; background: var(--bc-bg);
  border: 1px solid var(--bc-border); border-radius: var(--bc-radius);
  padding: 5px 9px; min-width: 12rem;
}
.braid-console__search:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 1px; }

.braid-console__notice {
  display: flex; gap: 8px; align-items: flex-start;
  background: var(--bc-warn-bg); color: var(--bc-warn-text);
  border: 1px solid var(--bc-warn-border); border-radius: var(--bc-radius);
  padding: 8px 10px; margin-bottom: var(--bc-gap);
}

.braid-console__table { width: 100%; border-collapse: collapse; }
.braid-console__table th {
  text-align: left; font-size: 12px; font-weight: 600; color: var(--bc-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
  padding: 6px 10px; border-bottom: 1px solid var(--bc-border);
}
.braid-console__table td { padding: 8px 10px; border-bottom: 1px solid var(--bc-border); vertical-align: top; }
.braid-console__table tbody tr:hover { background: var(--bc-surface); }

.braid-console__id { font-family: var(--bc-mono); font-weight: 600; }
.braid-console__desc { color: var(--bc-muted); margin-top: 2px; }
.braid-console__mono { font-family: var(--bc-mono); font-size: 12.5px; color: var(--bc-muted); }
.braid-console__patterns { display: flex; flex-direction: column; gap: 2px; }

.braid-console__tag {
  display: inline-block; font-size: 11.5px; padding: 1px 6px; margin: 0 4px 2px 0;
  border: 1px solid var(--bc-border); border-radius: 999px; color: var(--bc-muted);
}
.braid-console__badge {
  display: inline-block; font-size: 11.5px; padding: 1px 6px;
  border-radius: 999px; border: 1px solid var(--bc-border); font-family: var(--bc-mono);
}
.braid-console__badge--loadable { color: var(--bc-ok); border-color: currentColor; }
.braid-console__badge--gated { color: var(--bc-muted); }

.braid-console__empty { padding: 28px 10px; text-align: center; color: var(--bc-muted); }
.braid-console__error {
  border: 1px solid var(--bc-warn-border); background: var(--bc-warn-bg); color: var(--bc-warn-text);
  border-radius: var(--bc-radius); padding: 12px 14px;
}
.braid-console__error h3 { margin: 0 0 4px; font-size: 14px; }
.braid-console__retry {
  font: inherit; color: inherit; background: transparent; cursor: pointer; margin-top: 8px;
  border: 1px solid currentColor; border-radius: var(--bc-radius); padding: 4px 10px;
}

/* --- editor ------------------------------------------------------------- */

.braid-console__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.braid-console__card { border: 1px solid var(--bc-border); border-radius: var(--bc-radius); background: var(--bc-bg); }
.braid-console__cardhead { display: flex; align-items: center; gap: var(--bc-gap); padding: 8px 10px; flex-wrap: wrap; }

.braid-console__disclose {
  font: inherit; color: inherit; background: transparent; border: 0; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; padding: 0;
}
.braid-console__disclose:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 2px; }

.braid-console__ghost, .braid-console__primary {
  font: inherit; cursor: pointer; border-radius: var(--bc-radius); padding: 4px 10px;
  border: 1px solid var(--bc-border); background: transparent; color: inherit;
}
.braid-console__primary { background: var(--bc-accent); border-color: var(--bc-accent); color: #fff; font-weight: 600; }
.braid-console__ghost:disabled, .braid-console__primary:disabled { opacity: 0.45; cursor: not-allowed; }
.braid-console__ghost:focus-visible, .braid-console__primary:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 2px; }

.braid-console__badge--error { color: var(--bc-err); border-color: currentColor; }

.braid-console__findings { list-style: none; margin: 0; padding: 0 10px 8px; display: flex; flex-direction: column; gap: 4px; }
.braid-console__finding { font-size: 13px; padding-left: 10px; border-left: 2px solid var(--bc-border); }
.braid-console__finding--error { border-left-color: var(--bc-err); color: var(--bc-err); }
.braid-console__finding--warning { border-left-color: var(--bc-warn-border); color: var(--bc-warn-text); }

.braid-console__fields {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--bc-gap); padding: 10px; border-top: 1px solid var(--bc-border); background: var(--bc-surface);
}
.braid-console__field { display: flex; flex-direction: column; gap: 3px; }
.braid-console__fieldlabel { font-size: 12px; font-weight: 600; color: var(--bc-muted); display: flex; align-items: center; gap: 6px; }
.braid-console__field input, .braid-console__field select {
  font: inherit; color: inherit; background: var(--bc-bg);
  border: 1px solid var(--bc-border); border-radius: var(--bc-radius); padding: 5px 8px; width: 100%;
}
.braid-console__field input:focus-visible, .braid-console__field select:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 1px; }
.braid-console__field input:disabled { opacity: 0.6; }

.braid-console__owner {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;
  border: 1px solid var(--bc-border); border-radius: 999px; padding: 0 5px; color: var(--bc-muted);
}
.braid-console__owner--gateway { color: var(--bc-warn-text); border-color: var(--bc-warn-border); }

.braid-console__bar {
  position: sticky; bottom: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: var(--bc-gap); padding: 10px; background: var(--bc-surface);
  border: 1px solid var(--bc-border); border-radius: var(--bc-radius);
}
.braid-console__barstate { color: var(--bc-muted); }
.braid-console__barstate--error { color: var(--bc-err); font-weight: 600; }

.braid-console__notice--ok { background: transparent; color: var(--bc-ok); border-color: currentColor; }

.braid-console__diff {
  font-family: var(--bc-mono); font-size: 12.5px; padding: 10px; margin-top: var(--bc-gap);
  border: 1px solid var(--bc-border); border-radius: var(--bc-radius); background: var(--bc-surface);
  overflow-x: auto;
}
.braid-console__diffline { padding: 2px 0; }
.braid-console__diffline--add { color: var(--bc-ok); }
.braid-console__diffline--remove { color: var(--bc-err); }
.braid-console__diffield { padding: 2px 0 2px 16px; color: var(--bc-muted); }

/* Container query, not a media query: the library's width is its host's business, not the
   viewport's. A console in a 400px sidebar should stack even on a wide screen. */
@container (max-width: 640px) {
  .braid-console__table thead { display: none; }
  .braid-console__table tr { display: block; padding: 8px 0; border-bottom: 1px solid var(--bc-border); }
  .braid-console__table td { display: block; border: 0; padding: 2px 10px; }
}
`;

const STYLE_ELEMENT_ID = 'braid-console-styles';

/** Injects the stylesheet once per document. Safe to call from every mounted instance. */
export function ensureStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;

  const style = doc.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = CONSOLE_STYLES;
  doc.head.append(style);
}
