import {
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { BUILD_IDENTITY } from '../../generated/build-id';

/**
 * The tutorials, served across the federation boundary.
 *
 * This component is exposed as `./Tutorials` and rendered inside the HOST at
 * `/tutorials` — which makes the tutorials themselves a working example of
 * the thing they teach: content authored in one deployment (`docs/tutorials`,
 * shipped with this remote build *and* the host build as static assets),
 * presented by a component fetched at runtime from a separately deployed
 * application. Redeploy this remote and the host picks up the new tutorial
 * UI without shipping a build of its own.
 *
 * The markdown files are the single source of truth — the same files render
 * on GitHub. This component fetches them from `/tutorials/<slug>.md` on
 * whichever origin the page is running under (both builds carry the assets),
 * so it works federated, standalone, and behind the same-origin proxy alike.
 */

interface TutorialEntry {
  readonly slug: string;
  readonly title: string;
  readonly pkg: string;
  readonly summary: string;
}

const TUTORIALS: readonly TutorialEntry[] = [
  {
    slug: '01-core',
    title: 'Version the data, not the deploy',
    pkg: '@braid/skew',
    summary:
      'Envelopes, migration chains in both directions, labeled guesses, and storage that refuses to lie.',
  },
  {
    slug: '02-build',
    title: 'Give your build a name',
    pkg: '@braid/build',
    summary:
      'Stamped identity, the served manifest, stale-origin detection, and generated frozen types.',
  },
  {
    slug: '03-angular-core',
    title: 'Versioned stores, the Angular way',
    pkg: '@braid/angular-core',
    summary:
      'A versioned store through DI, read as Signals with zero flicker and typed failure states.',
  },
  {
    slug: '04-angular-data',
    title: 'One graph, durable writes',
    pkg: '@braid/angular-data',
    summary:
      'Normalized queries, optimistic mutations with precise rollback, and the version-aware outbox.',
  },
];

@Component({
  selector: 'remote-tutorials',
  styleUrl: './tutorials.css',
  template: `
    <div class="tutorials">
      <aside class="toc">
        <div class="toc-head">
          <span class="badge">⬡ REMOTE</span>
          <p>
            Rendered by <code>prod-remote</code> build
            <code>{{ buildId }}</code> — the tutorials cross the same
            deployment boundary they teach about.
          </p>
        </div>
        @for (t of tutorials; track t.slug) {
          <button
            class="toc-entry"
            [class.active]="selected() === t.slug"
            (click)="open(t.slug)"
          >
            <span class="pkg">{{ t.pkg }}</span>
            <span class="title">{{ t.title }}</span>
            <span class="summary">{{ t.summary }}</span>
          </button>
        }
      </aside>

      <!--
        Delegation container, not a control: the handler only acts on clicks that originated on
        an <a> inside the rendered markdown, and those anchors are already keyboard accessible —
        Enter on a link fires a click that bubbles to here. Making the <article> focusable and
        adding key handlers would announce a non-interactive region as interactive, which is
        worse for screen readers than the rule it satisfies.
      -->
      <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
      <article class="page" (click)="onContentClick($event)">
        @if (error(); as message) {
          <div class="load-error">
            <strong>Could not load this tutorial.</strong>
            <p>{{ message }}</p>
          </div>
        } @else if (html(); as content) {
          <div class="markdown" [innerHTML]="content"></div>
        } @else {
          <p class="loading">Loading…</p>
        }
      </article>
    </div>
  `,
})
export class Tutorials {
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly tutorials = TUTORIALS;
  protected readonly buildId = BUILD_IDENTITY.buildId;

  protected readonly selected = signal<string>(TUTORIALS[0]?.slug ?? '01-core');
  protected readonly error = signal<string | null>(null);
  private readonly rendered = signal<SafeHtml | null>(null);
  protected readonly html = computed(() => this.rendered());

  constructor() {
    void this.load(this.selected());
  }

  protected open(slug: string): void {
    if (slug === this.selected()) return;
    this.selected.set(slug);
    this.rendered.set(null);
    void this.load(slug);
  }

  /**
   * Cross-tutorial links in the markdown (`](02-build.md)`) select in place
   * instead of navigating the page to a raw .md file. External links pass
   * through; other repo-relative links are inert here — they exist for the
   * GitHub rendering of the same files.
   */
  protected onContentClick(event: Event): void {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (/^https?:\/\//.test(href)) return;

    event.preventDefault();
    const slug = href.replace(/\.md$/, '');
    if (TUTORIALS.some((t) => t.slug === slug)) this.open(slug);
  }

  private async load(slug: string): Promise<void> {
    this.error.set(null);
    try {
      // `tutorial-content/`, not `tutorials/` — the content directory must
      // not collide with the host's `/tutorials` route, or a static server
      // answers with the directory instead of the app.
      const response = await fetch(`tutorial-content/${slug}.md`);
      if (!response.ok) {
        throw new Error(`tutorial-content/${slug}.md answered HTTP ${response.status}`);
      }
      const markdown = await response.text();
      if (this.selected() !== slug) return; // a newer selection won

      const html = (marked.parse(markdown, { async: false }) as string)
        // The markdown references images relative to its own directory so
        // GitHub renders them; in the app they are served under
        // /tutorial-content/.
        .replace(/src="assets\//g, 'src="tutorial-content/assets/');

      this.rendered.set(this.sanitizer.bypassSecurityTrustHtml(html));
    } catch (caught) {
      if (this.selected() !== slug) return;
      this.error.set(caught instanceof Error ? caught.message : String(caught));
    }
  }
}
