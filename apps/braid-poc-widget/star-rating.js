/**
 * A plain custom element, deployed on its own. No build step, no framework, and — the point —
 * no Braid: it does not import anything from the runtime and does not know it is being composed.
 *
 * The gateway's manifest says `"adapter": "custom-element"`, `"entry": "/star-rating.js"` and
 * `"element": "star-rating"`; the adapter evaluates this module inside the fragment's realm,
 * creates the element there, and moves it into the host's page.
 */
class StarRating extends HTMLElement {
  #value = 0;
  #label = 'Rating';
  #root = this.attachShadow({ mode: 'open' });

  /** Set as a DOM property by the adapter, from the slot's props. */
  set value(next) {
    this.#value = Math.max(0, Math.min(5, Number(next) || 0));
    this.#render();
  }
  get value() {
    return this.#value;
  }

  set label(next) {
    this.#label = String(next ?? 'Rating');
    this.#render();
  }
  get label() {
    return this.#label;
  }

  connectedCallback() {
    this.#render();
  }

  /**
   * Fired when the user picks a star. The manifest lists `rating:change` under `events`, so the
   * adapter republishes it to the host as a `braid:event`.
   */
  #emit() {
    this.dispatchEvent(new CustomEvent('rating:change', { detail: { value: this.#value } }));
  }

  #render() {
    if (!this.#root) return;

    this.#root.innerHTML = `
      <style>
        :host { display: block; font-family: system-ui, sans-serif; }
        .row { display: flex; align-items: center; gap: 0.5rem; }
        .label { color: #92400e; font-weight: 600; }
        button {
          font-size: 1.35rem; line-height: 1; background: none; border: none; cursor: pointer;
          padding: 0 0.05rem; color: #d97706;
        }
        button[aria-pressed='false'] { color: #d6d3d1; }
        .value { color: #78716c; font-size: 0.85rem; }
      </style>
      <div class="row" role="group" aria-label="${escapeHtml(this.#label)}">
        <span class="label">${escapeHtml(this.#label)}</span>
        ${[1, 2, 3, 4, 5]
          .map(
            (star) =>
              `<button type="button" data-star="${star}" aria-pressed="${star <= this.#value}"
                 aria-label="${star} star${star === 1 ? '' : 's'}">★</button>`,
          )
          .join('')}
        <span class="value">${this.#value} / 5</span>
      </div>
    `;

    for (const button of this.#root.querySelectorAll('button')) {
      button.addEventListener('click', () => {
        this.value = Number(button.dataset.star);
        this.#emit();
      });
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

customElements.define('star-rating', StarRating);
