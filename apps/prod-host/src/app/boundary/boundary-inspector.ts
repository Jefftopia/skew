import { Component, computed, inject } from '@angular/core';
import { CrossingStore, type Verdict } from './crossing';
import { JsonDiff } from './json-diff';

const ICON: Record<Verdict, string> = {
  migrated: '✓',
  current: '✓',
  refused: '⛔',
  corrupted: '✕',
  error: '✕',
};

/**
 * Draws the most recent version-boundary crossing.
 *
 * This replaced a scrolling terminal-style log, and the reason is worth
 * stating: the log was *accurate* and nearly useless. `refused: ahead — found
 * v2` contains every fact you need and arranges none of them — you had to
 * already understand the problem to read it, which is exactly backwards for
 * something whose job is to teach the problem.
 *
 * So the same event is drawn instead: who wrote it, what crossed, who read
 * it, what was decided, and — the part the log could never show — what
 * happened to each individual field. "It migrated" turns out not to be one
 * fact but several, and some of them are guesses.
 */
@Component({
  selector: 'host-boundary-inspector',
  imports: [JsonDiff],
  styleUrl: './boundary-inspector.css',
  template: `
    <div class="inspector">
      @if (crossing(); as c) {
        <div class="diagram">
          <div class="party">
            <div class="role">{{ c.from.label }}</div>
            <div class="build">{{ c.from.build }}</div>
            <div class="understands">
              understands <strong>v{{ c.from.understands }}</strong>
            </div>
          </div>

          <div class="flight">
            <span class="arrow">──▶</span>
            @if (c.envelopeVersion !== null) {
              <span class="envelope"
                >{{ '{' }} v: {{ c.envelopeVersion }} {{ '}' }}</span
              >
            } @else {
              <span class="envelope bare">no envelope</span>
            }
            <span class="arrow">──▶</span>
          </div>

          <div class="party">
            <div class="role">{{ c.to.label }}</div>
            <div class="build">{{ c.to.build }}</div>
            <div class="understands">
              understands <strong>v{{ c.to.understands }}</strong>
            </div>
          </div>
        </div>

        <div class="verdict-bar" [class]="'v-' + c.verdict">
          <span class="icon">{{ icon(c.verdict) }}</span>
          <div>
            <h4>
              {{ c.headline }}
              @if (c.unprotected) {
                <span class="unprotected-tag">protections off</span>
              }
            </h4>
            <p>{{ c.detail }}</p>
          </div>
        </div>

        @if (c.fields?.length) {
          <div class="fields">
            <p class="fields-caption">what happened to each field</p>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Before</th>
                  <th>After</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (f of c.fields; track f.name) {
                  <tr>
                    <td class="name">{{ f.name }}</td>
                    <td class="val">{{ f.before }}</td>
                    <td class="val">{{ f.after }}</td>
                    <td>
                      <span class="tag" [class]="'tag ' + f.status">{{
                        f.status
                      }}</span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>

            @if (hasDerived()) {
              <p class="derived-note">
                <strong>Derived</strong> means the migration had no source data
                for that field and filled in a placeholder. It is the best
                answer available from the older shape — not a reported value.
                Anything downstream that treats it as real is trusting a guess.
              </p>
            }
          </div>
        }

        <!--
          The record itself, as a diff. Open by default when there is one:
          the table above says what happened to each field, but "show me the
          actual JSON" is the next question every time, and hiding it behind a
          disclosure makes people ask it twice.
        -->
        @if (c.before !== undefined && c.after !== undefined) {
          <div class="diff-wrap">
            <p class="fields-caption">the payload, before and after the cast</p>
            <host-json-diff
              [before]="c.before"
              [after]="c.after"
              [derivedPaths]="c.derivedPaths ?? []"
              [lossyPaths]="c.lossyPaths ?? []"
              [beforeLabel]="diffLabels().before"
              [afterLabel]="diffLabels().after"
            />
          </div>
        }

        @if (c.raw) {
          <details>
            <summary>Show the raw payload the reader received</summary>
            <pre>{{ c.raw }}</pre>
          </details>
        }
      } @else {
        <p class="inspector-empty">
          Run a step and this shows what crossed the boundary between the two
          builds — and what it cost.
        </p>
      }
    </div>
  `,
})
export class BoundaryInspector {
  private readonly store = inject(CrossingStore);
  protected readonly crossing = this.store.latest;

  protected readonly hasDerived = computed(() =>
    (this.crossing()?.fields ?? []).some((f) => f.status === 'derived'),
  );

  /**
   * Names the two sides in the reader's terms — "v1 (on disk)" beats
   * "before" when the entire lesson is which version each side is.
   */
  protected readonly diffLabels = computed(() => {
    const c = this.crossing();
    const found = c?.envelopeVersion;
    const reader = c?.to.understands;
    return {
      before: found ? `v${found} · as written` : 'as written',
      after: reader ? `v${reader} · as read` : 'as read',
    };
  });

  protected icon(v: Verdict): string {
    return ICON[v];
  }
}
