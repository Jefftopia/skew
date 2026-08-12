import { Component, inject, signal } from '@angular/core';
import { resetSchemaRegistry } from '@skewkit/core';
import { SharedStore } from '../shared-store';
import { DRAFT_KEY, DraftSchemaV1, type DraftV1 } from '../domain';
import { Lab } from '../lab';
import { BUILD_IDENTITY } from '../app.config';
import { sendToRemote, type FieldChange, type RemoteResult } from '../bridge';
import { CrossingStore } from '../boundary/crossing';

type StepState = 'idle' | 'running' | 'done' | 'failed';

interface Step {
  readonly n: number;
  readonly where: 'host' | 'remote';
  readonly title: string;
  readonly blurb: string;
  readonly cta: string;
  readonly run: () => Promise<{ ok: boolean; summary: string }>;
}

const HOST_PARTY = {
  label: 'Host — older build',
  build: BUILD_IDENTITY.buildId,
  understands: 1,
};

/**
 * The five-step round trip, driven from one list.
 *
 * The demo used to be four independent cards that each said, in effect, "now
 * go do the other half of this in the other application." That is a fine
 * description of the problem and a miserable way to experience it: you lost
 * your place every time, and the two halves of a single comparison were never
 * on screen together.
 *
 * Now the remote sits in the drawer to the right, permanently visible, and
 * the steps that belong to *it* are dispatched over the command channel in
 * `bridge.ts` rather than asking the user to go find a button. Each step
 * updates the Boundary Inspector above, so the diagram is the running
 * narration and there is nothing to read in a log.
 *
 * The remote's own buttons still work — driving it from here is an
 * affordance, not a replacement for it being a real application.
 */
@Component({
  selector: 'host-walkthrough',
  styleUrl: './walkthrough.css',
  template: `
    <div class="story">
      <div class="story-head">
        <h3>One record, across two builds</h3>
        <p>
          The host writes a draft it understands; the remote reads it and
          migrates it forward. Then the remote writes one, and the host — which
          has never heard of the newer shape — has to decide what to do with
          it. Finally the remote shares what it knows, and the refusal turns
          into an honest projection. Watch the diagram above after each step.
        </p>
        <div class="story-actions">
          <button class="run" (click)="runAll()" [disabled]="busy()">
            {{ busy() ? 'Running…' : 'Run all five' }}
          </button>
          <button class="run secondary" (click)="reset()" [disabled]="busy()">
            Reset
          </button>
        </div>
      </div>

      <ol class="steps">
        @for (s of steps; track s.n) {
          <li
            class="step"
            [class]="'step ' + state(s.n)"
            [class.active]="cursor() === s.n"
          >
            <span class="marker">{{
              state(s.n) === 'done' ? '✓' : state(s.n) === 'failed' ? '!' : s.n
            }}</span>
            <div class="body">
              <span class="where" [class]="'where ' + s.where">{{
                s.where === 'host' ? 'runs in host' : 'runs in remote →'
              }}</span>
              <h4>{{ s.title }}</h4>
              <p>{{ s.blurb }}</p>
              @if (summary(s.n); as text) {
                <div
                  class="outcome"
                  [class.ok]="state(s.n) === 'done'"
                  [class.bad]="state(s.n) === 'failed'"
                >
                  {{ text }}
                </div>
              }
            </div>
            <button class="run" (click)="runOne(s)" [disabled]="busy()">
              {{ s.cta }}
            </button>
          </li>
        }
      </ol>
    </div>
  `,
})
export class Walkthrough {
  private readonly lab = inject(Lab);
  private readonly crossings = inject(CrossingStore);

  private readonly states = signal<Record<number, StepState>>({});
  private readonly summaries = signal<Record<number, string>>({});
  protected readonly busy = signal(false);
  protected readonly cursor = signal(1);

  private readonly shared = inject(SharedStore);

  /**
   * This build knows v1 and only v1. Built per call rather than held, so the
   * driver toggle in the store panel takes effect immediately instead of on
   * the next reload.
   */
  private get store() {
    return this.shared.store(DraftSchemaV1);
  }

  protected readonly steps: Step[] = [
    {
      n: 1,
      where: 'host',
      title: 'The host writes a draft',
      blurb:
        'Schema v1, where `author` is a plain string. The record is wrapped in an envelope that names its version — that envelope is the entire mechanism.',
      cta: 'Write v1',
      run: () => this.hostWrite(),
    },
    {
      n: 2,
      where: 'remote',
      title: 'The remote reads it',
      blurb:
        'The remote ships v2: `author` became an object and a `summary` field was added. It migrates the host’s record forward on the way in.',
      cta: 'Read as v2',
      run: () => this.remoteStep('read-record-as-v2', 'host-to-remote'),
    },
    {
      n: 3,
      where: 'remote',
      title: 'Now the remote writes one',
      blurb:
        'Same storage key, but stamped v2 — a shape the host has never seen and cannot represent.',
      cta: 'Write v2',
      run: () => this.remoteStep('write-v2-record', 'none'),
    },
    {
      n: 4,
      where: 'host',
      title: 'The host tries to read it',
      blurb:
        'Data from the future. This build, on its own, has no way down — the fields v2 added were never sent to it. Try this once with protections on and once with them off — the difference is the whole argument.',
      cta: 'Read as v1',
      run: () => this.hostRead(),
    },
    {
      n: 5,
      where: 'host',
      title: 'Borrow the remote’s knowledge',
      blurb:
        'Both builds share one @skewkit/core instance. The remote registers its chain — including the way *down* — and the exact read that refused in step 4 now returns an honest, lossy projection that names what it dropped.',
      cta: 'Register & re-read',
      run: () => this.hostReadViaRegistry(),
    },
  ];

  protected state(n: number): StepState {
    return this.states()[n] ?? 'idle';
  }

  protected summary(n: number): string | null {
    return this.summaries()[n] ?? null;
  }

  protected async runOne(step: Step): Promise<void> {
    this.busy.set(true);
    this.cursor.set(step.n);
    this.setState(step.n, 'running');
    try {
      const result = await step.run();
      this.setState(step.n, result.ok ? 'done' : 'failed');
      this.setSummary(step.n, result.summary);
    } finally {
      this.busy.set(false);
    }
  }

  protected async runAll(): Promise<void> {
    this.busy.set(true);
    try {
      for (const step of this.steps) {
        this.cursor.set(step.n);
        this.setState(step.n, 'running');
        const result = await step.run();
        this.setState(step.n, result.ok ? 'done' : 'failed');
        this.setSummary(step.n, result.summary);
        // A beat between steps so the inspector visibly changes rather than
        // flashing through four states faster than anyone can read.
        await new Promise((r) => setTimeout(r, 550));
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async reset(): Promise<void> {
    this.busy.set(true);
    try {
      await this.store.remove(DRAFT_KEY);
      await sendToRemote('clear-record');
      // Step 5 teaches the page the remote's chain, and the registry
      // remembers for the life of the tab — so without this, step 4 would
      // downgrade instead of refuse on the second run-through. Resetting
      // drops *all* page-learned steps (a re-visit to the Portfolio tab's
      // remote re-registers its own), which is exactly the pristine
      // "two strangers" state the walkthrough starts from.
      resetSchemaRegistry();
      this.shared.touched();
      this.states.set({});
      this.summaries.set({});
      this.cursor.set(1);
      this.crossings.clear();
    } finally {
      this.busy.set(false);
    }
  }

  // --- host-side steps ----------------------------------------------------

  private async hostWrite(): Promise<{ ok: boolean; summary: string }> {
    const record: DraftV1 = {
      id: 'demo-1',
      title: 'Second Sunday of Advent',
      author: 'Rev. Bernard J. Miller',
      body: 'Prepare the way of the Lord, make straight his paths.',
    };
    await this.store.set(DRAFT_KEY, record);

    // Read the bytes back rather than reconstructing them — the inspector
    // should show what is genuinely on disk, not what we believe we wrote.
    this.shared.touched();
    const bytes = (await this.shared.rawAt(this.store.keyFor(DRAFT_KEY))) ?? '';
    const guarded = this.lab.guarded();

    this.lab.write(
      'ok',
      'walkthrough',
      guarded ? 'host wrote a v1 envelope' : 'host wrote a bare object',
    );

    this.crossings.set({
      from: HOST_PARTY,
      to: {
        label: 'Storage — any later reader',
        build: 'localStorage',
        understands: 1,
      },
      envelopeVersion: guarded ? 1 : null,
      verdict: guarded ? 'current' : 'corrupted',
      unprotected: !guarded,
      headline: guarded ? 'Written as v1' : 'Written with no envelope',
      detail: guarded
        ? 'The version travels with the record, so any future reader can tell what it is looking at before it parses a single field.'
        : 'Nothing in these bytes says which schema produced them. A future reader can only assume — and assuming is the bug this whole demo is about.',
      raw: bytes ? JSON.stringify(JSON.parse(bytes), null, 2) : undefined,
    });

    return {
      ok: true,
      summary: guarded
        ? 'Stored as { v: 1, payload }. The record now carries its own version.'
        : 'Stored as a bare object. Unidentifiable to any later reader.',
    };
  }

  private async hostRead(): Promise<{ ok: boolean; summary: string }> {
    const result = await this.store.get(DRAFT_KEY);
    const guarded = this.lab.guarded();

    if (!result.ok) {
      this.lab.write('ok', 'walkthrough', `host refused: ${result.reason}`);
      this.crossings.set({
        from: {
          label: 'Remote — newer build',
          build: 'prod-remote',
          understands: 2,
        },
        to: HOST_PARTY,
        envelopeVersion: result.found ?? 2,
        verdict: 'refused',
        unprotected: false,
        headline: `Refused — ${result.reason}`,
        detail:
          result.reason === 'ahead'
            ? `The record is v${result.found}; this build understands v${result.expected}. Migrating downward would mean inventing the fields v2 added, so the read stops here — at the boundary, where the cause is obvious. The record on disk was not touched.`
            : result.message,
      });
      return {
        ok: true,
        summary: `Refused with reason "${result.reason}". The data is intact and the failure is legible.`,
      };
    }

    // Protections are off: the read "succeeded" and handed back a shape this
    // build cannot use. The next line is what any consumer would do with it.
    let consumerError: string | null = null;
    let label = '';
    try {
      label = (result.value.author as string).toUpperCase();
    } catch (error) {
      consumerError = error instanceof Error ? error.message : String(error);
    }

    const raw = JSON.stringify(result.value, null, 2);

    if (consumerError) {
      this.lab.write('fail', 'walkthrough', `consumer threw: ${consumerError}`);
      this.crossings.set({
        from: {
          label: 'Remote — newer build',
          build: 'prod-remote',
          understands: 2,
        },
        to: HOST_PARTY,
        envelopeVersion: await this.envelopeVersionOnDisk(),
        verdict: 'corrupted',
        unprotected: !guarded,
        headline: 'TypeError, far from the cause',
        detail: `${consumerError} — the read reported success and handed back a shape this build cannot use. The stack points at the formatter, not at the storage call that let it through. This is the bug that takes a day to find.`,
        fields: this.describeMismatch(
          result.value as unknown as Record<string, unknown>,
        ),
        raw,
      });
      return { ok: false, summary: `The consumer threw: ${consumerError}` };
    }

    this.crossings.set({
      from: HOST_PARTY,
      to: HOST_PARTY,
      envelopeVersion: 1,
      verdict: result.migratedFrom ? 'migrated' : 'current',
      unprotected: !guarded,
      headline: result.migratedFrom
        ? `Migrated v${result.migratedFrom} → v1`
        : 'Read at v1',
      detail: `The consumer used it without incident: author.toUpperCase() = "${label}". Run step 3 first to see what happens when the record is from a newer build.`,
      raw,
    });
    return {
      ok: true,
      summary: `Read cleanly — author.toUpperCase() = "${label}".`,
    };
  }

  /**
   * Step 5: ask the remote to register its chain, then run the exact read
   * that refused in step 4.
   *
   * Nothing about the host's code changes between the two steps — same
   * schema, same `get`, same key. What changed is the page: the registry now
   * holds a v1 → v2 step with a down direction, contributed by the only
   * party that could know it. The result is `ok` with `downgradedFrom: 2`,
   * and `lossyPaths` naming the fields the projection had to drop.
   */
  private async hostReadViaRegistry(): Promise<{
    ok: boolean;
    summary: string;
  }> {
    const registration = await sendToRemote('register-schema');
    if (!registration.ok) {
      return {
        ok: false,
        summary: `The remote could not register its chain: ${registration.detail}`,
      };
    }
    this.lab.write('ok', 'walkthrough', `remote: ${registration.headline}`);

    const result = await this.store.get(DRAFT_KEY);
    if (!result.ok) {
      return {
        ok: false,
        summary: `Read still failed (${result.reason}). Run step 3 first so there is a v2 record to downgrade.`,
      };
    }

    const raw = JSON.stringify(result.value, null, 2);

    if (!result.downgradedFrom) {
      return {
        ok: true,
        summary: `The record was already v1 (nothing to downgrade). Run steps 3 and 4, then this one.`,
      };
    }

    this.lab.write(
      'ok',
      'walkthrough',
      `host downgraded v${result.downgradedFrom} → v1 via the registry; lost: ${result.lossyPaths.join(', ')}`,
    );

    this.crossings.set({
      from: {
        label: 'Remote — newer build',
        build: 'prod-remote',
        understands: result.downgradedFrom,
      },
      to: HOST_PARTY,
      envelopeVersion: result.downgradedFrom,
      verdict: 'migrated',
      unprotected: !this.lab.guarded(),
      headline: `Downgraded v${result.downgradedFrom} → v1 — via the shared registry`,
      detail:
        'The same read that refused a step ago. The host still knows only v1; the down-migration ran from the step the remote just registered. The projection is honest about its cost — the fields below marked "lost" are what v1 cannot carry.',
      fields: await this.describeDowngrade(
        result.value as unknown as Record<string, unknown>,
        result.lossyPaths,
      ),
      // The v2 record still on disk against the v1 projection just produced:
      // the diff is where "lossy" stops being a word and becomes two struck
      // lines the reader can point at.
      before: await this.storedPayload(),
      after: result.value,
      derivedPaths: result.derivedPaths,
      lossyPaths: result.lossyPaths,
      raw,
    });

    return {
      ok: true,
      summary:
        `Downgraded v${result.downgradedFrom} → v1; lost ${result.lossyPaths.join(', ')}. ` +
        'Run step 4 again — the page now knows the way down, and the refusal is gone until Reset.',
    };
  }

  /** The payload currently on disk, unwrapped from its envelope. */
  private async storedPayload(): Promise<unknown> {
    try {
      const bytes = await this.shared.rawAt(this.store.keyFor(DRAFT_KEY));
      const parsed = bytes ? JSON.parse(bytes) : null;
      return parsed?.payload ?? parsed ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The projection, field by field: what v1 kept, and what it had to drop.
   * "Before" comes from the bytes genuinely on disk, not from a
   * reconstruction.
   */
  private async describeDowngrade(
    projected: Record<string, unknown>,
    lossyPaths: readonly string[],
  ): Promise<FieldChange[]> {
    let before: Record<string, unknown> = {};
    try {
      const bytes = await this.shared.rawAt(this.store.keyFor(DRAFT_KEY));
      const parsed = bytes ? JSON.parse(bytes) : null;
      before = (parsed?.payload ?? {}) as Record<string, unknown>;
    } catch {
      /* the table degrades to em-dashes rather than breaking the read */
    }

    const describe = (v: unknown): string =>
      v === undefined
        ? '—'
        : typeof v === 'object' && v !== null
          ? JSON.stringify(v)
          : String(v);

    const atPath = (source: Record<string, unknown>, path: string): unknown =>
      path
        .split('.')
        .reduce<unknown>(
          (acc, key) =>
            typeof acc === 'object' && acc !== null
              ? (acc as Record<string, unknown>)[key]
              : undefined,
          source,
        );

    const rows: FieldChange[] = Object.keys(projected).map((name) => {
      const was = describe(before[name]);
      const now = describe(projected[name]);
      return {
        name,
        before: was,
        after: now,
        status: was === now ? 'same' : 'migrated',
      };
    });

    for (const path of lossyPaths) {
      rows.push({
        name: path,
        before: describe(atPath(before, path)),
        after: '— (v1 cannot carry it)',
        status: 'lost',
      });
    }

    return rows;
  }

  /**
   * The envelope version genuinely on disk, or `null` if there isn't one.
   *
   * Read rather than assumed: with the protections off, the writer skipped the
   * envelope entirely, and the diagram should show that instead of a version
   * we merely expected to be there.
   */
  private envelopeVersionOnDisk(): number | null {
    try {
      const raw = globalThis.localStorage?.getItem(
        this.store.keyFor(DRAFT_KEY),
      );
      const parsed = raw ? JSON.parse(raw) : null;
      return typeof parsed?.v === 'number' ? parsed.v : null;
    } catch {
      return null;
    }
  }

  /**
   * What this build expected each field to be, against what actually arrived.
   *
   * Derived from the real value rather than written out by hand. An earlier
   * version of this hardcoded the table — which produced a confident,
   * plausible, and *wrong* row the moment the scenario changed shape. A demo
   * whose entire argument is "do not assume, check" cannot afford a fabricated
   * exhibit.
   */
  private describeMismatch(received: Record<string, unknown>): FieldChange[] {
    const expected: Record<string, string> = {
      id: 'string',
      title: 'string',
      author: 'string',
      body: 'string',
    };

    const describe = (v: unknown): string =>
      v === undefined
        ? 'undefined'
        : typeof v === 'object' && v !== null
          ? JSON.stringify(v)
          : typeof v;

    const rows: FieldChange[] = Object.entries(expected).map(([name, want]) => {
      const got = describe(received[name]);
      const matches = typeof received[name] === want;
      return {
        name,
        before: `${want} (v1 expects)`,
        after: matches ? want : got,
        status: matches ? 'same' : 'lost',
      };
    });

    // Anything v2 added that v1 has no idea what to do with.
    for (const key of Object.keys(received)) {
      if (key in expected) continue;
      rows.push({
        name: key,
        before: '— (v1 has no such field)',
        after: describe(received[key]),
        status: 'lost',
      });
    }

    return rows;
  }

  // --- remote-side steps --------------------------------------------------

  private async remoteStep(
    action: 'read-record-as-v2' | 'write-v2-record',
    direction: 'host-to-remote' | 'none',
  ): Promise<{ ok: boolean; summary: string }> {
    const result: RemoteResult = await sendToRemote(action);
    // The remote just wrote through its own copy of the store module; nothing
    // in this bundle observed it, so nudge the panel by hand.
    this.shared.touched();
    this.lab.write(
      result.ok ? 'ok' : 'warn',
      'walkthrough',
      `remote: ${result.headline}`,
    );

    const remoteParty = {
      label: 'Remote — newer build',
      build: result.raw ? 'prod-remote' : 'prod-remote',
      understands: result.expectedVersion ?? 2,
    };

    if (direction === 'host-to-remote') {
      this.crossings.set({
        from: HOST_PARTY,
        to: remoteParty,
        envelopeVersion: result.foundVersion ?? null,
        verdict: result.ok
          ? result.foundVersion === 1
            ? 'migrated'
            : 'current'
          : 'error',
        unprotected: !this.lab.guarded(),
        headline: result.headline,
        detail: result.detail,
        fields: result.fields as FieldChange[] | undefined,
        before: result.before,
        after: result.after,
        derivedPaths: result.derivedPaths,
        lossyPaths: result.lossyPaths,
        raw: result.raw,
      });
    } else {
      this.crossings.set({
        from: remoteParty,
        to: {
          label: 'Storage — any later reader',
          build: 'localStorage',
          understands: 2,
        },
        envelopeVersion: result.foundVersion ?? 2,
        verdict: result.ok ? 'current' : 'error',
        unprotected: !this.lab.guarded(),
        headline: result.headline,
        detail: result.detail,
        raw: result.raw,
      });
    }

    return { ok: result.ok, summary: `${result.headline} — ${result.detail}` };
  }

  // --- bookkeeping --------------------------------------------------------

  private setState(n: number, state: StepState): void {
    this.states.update((prev) => ({ ...prev, [n]: state }));
  }

  private setSummary(n: number, text: string): void {
    this.summaries.update((prev) => ({ ...prev, [n]: text }));
  }
}
