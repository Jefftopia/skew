import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { diffPayloads } from '@braid/studio';

/**
 * A git-style diff of the payload before and after a cast.
 *
 * The field table beside this answers "what happened to each field". This
 * answers the question people ask next — "show me the record" — in the one
 * format every developer already knows how to read.
 *
 * All of the thinking lives in `@braid/studio`'s `diffPayloads`: pairing lines
 * by key path rather than by line number, and carrying the migration's own
 * vocabulary (a guessed value is not the same claim as a carried one). This
 * component is the renderer, and the remote app has its own copy of exactly
 * this template for the same reason it has its own `domain.ts` — the two
 * builds share a library, not a component tree.
 */
@Component({
  selector: 'remote-json-diff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './json-diff.css',
  template: `
    <div class="diff">
      <div class="diff-head">
        <span class="side before">− {{ beforeLabel() }}</span>
        <span class="side after">+ {{ afterLabel() }}</span>
        <span class="counts">
          <span class="plus">+{{ stats().added }}</span>
          <span class="minus">−{{ stats().removed }}</span>
          @if (stats().derived > 0) {
            <span class="chip derived">{{ stats().derived }} derived</span>
          }
          @if (stats().lost > 0) {
            <span class="chip lost">{{ stats().lost }} lost</span>
          }
        </span>
      </div>

      <pre class="diff-body"><code>@for (l of lines(); track $index) {<span
        class="row"
        [class.add]="l.kind === 'add'"
        [class.del]="l.kind === 'del'"
        [class.derived]="l.tag === 'derived'"
        [class.lost]="l.tag === 'lost'"
      ><span class="gutter">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span><span
        class="text">{{ pad(l.indent) }}{{ l.text }}</span>@if (l.tag) {<span
        class="badge">{{ l.tag === 'derived' ? 'guessed' : 'cannot be carried' }}</span>}
</span>}</code></pre>

      @if (stats().derived > 0) {
        <p class="legend">
          <strong>guessed</strong> — the migration filled this in; the writer
          never recorded it. Treating it as reported data is trusting a guess.
        </p>
      }
      @if (stats().lost > 0) {
        <p class="legend">
          <strong>cannot be carried</strong> — the older shape has nowhere to
          put this, so the projection drops it. It is still intact in the
          record that was read.
        </p>
      }
    </div>
  `,
})
export class JsonDiff {
  readonly before = input<unknown>();
  readonly after = input<unknown>();
  /** Dot-paths the migration invented rather than carried over. */
  readonly derivedPaths = input<readonly string[]>([]);
  /** Dot-paths a downgrade had to discard. */
  readonly lossyPaths = input<readonly string[]>([]);
  readonly beforeLabel = input('before');
  readonly afterLabel = input('after');

  private readonly diff = computed(() =>
    diffPayloads(this.before(), this.after(), {
      derivedPaths: this.derivedPaths(),
      lossyPaths: this.lossyPaths(),
    }),
  );

  protected readonly lines = computed(() => this.diff().lines);
  protected readonly stats = computed(() => this.diff().stats);

  protected pad(indent: number): string {
    return '  '.repeat(indent);
  }
}
