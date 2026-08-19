/**
 * Renders text the host is typing, live, from a different application.
 *
 * A plain custom element, deployed on its own. No build step, no framework, and no Braid import —
 * it does not know it is being composed.
 *
 * **The mechanism is worth naming precisely, because "live sync" invites the wrong question:
 * nothing leaves the page.** The host writes a prop; the adapter structured-clones it across the
 * realm boundary and assigns it as a DOM property here. No socket, no server, and no JavaScript
 * object shared between the two applications.
 *
 * Props are the supported host → fragment channel, and they are delivered through `env` — which
 * the *contract* adapters provide. A compat-mode fragment has no equivalent today, which is why
 * this panel is a custom element rather than part of the Angular remote.
 */
class LiveText extends HTMLElement {
  #text = '';
  #root = this.attachShadow({ mode: 'open' });

  /** Set as a DOM property by the adapter whenever the host's props change. */
  set text(next) {
    this.#text = String(next ?? '');
    this.#render();
  }
  get text() {
    return this.#text;
  }

  connectedCallback() {
    this.#render();
  }

  #render() {
    if (!this.#root) return;
    this.#root.innerHTML = `
      <style>
        :host { display: block; font-family: system-ui, sans-serif; }
        .live {
          display: flex; align-items: center; gap: 0.6rem; min-height: 2.2rem;
          padding: 0.5rem 0.7rem; border: 1px solid #ddd6fe; border-radius: 6px; background: #f5f3ff;
          font-size: 0.88rem;
        }
        .who { font-size: 0.7rem; background: #7c3aed; color: #fff; border-radius: 999px; padding: 0.1rem 0.45rem; flex: none; }
        .empty { color: #8b8ba7; font-style: italic; }
        strong { word-break: break-word; }
      </style>
      <div class="live">
        <span class="who">live-text (separate app)</span>
        ${
          this.#text
            ? `<strong>${escapeHtml(this.#text)}</strong>`
            : `<span class="empty">…waiting for the host to type</span>`
        }
      </div>
    `;
  }
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}

customElements.define('live-text', LiveText);
