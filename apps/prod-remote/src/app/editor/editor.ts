import { Component, DestroyRef, inject, signal } from '@angular/core';
import { isSkewDisabled, registerSchema } from '@skew/core';
import { rawAt, storeOn } from '../shared-store';
import {
  listenForCommands,
  type FieldChange,
  type RemoteAction,
  type RemoteResult,
} from '../commands';
import { runSchema } from '@skew/angular-workflow';
import {
  DRAFT_KEY,
  DraftSchemaV2,
  type DraftV2,
  WizardDataSchemaV2,
  type WizardDataV2,
  wizardV2,
} from '../domain';
import { BUILD_IDENTITY } from '../../generated/build-id';
import { trace } from '../trace';

interface Outcome {
  readonly ok: boolean;
  readonly headline: string;
  readonly detail: string;
}

/**
 * The exposed module — the only thing the host knows about this application,
 * and it knows it by URL, not by import.
 *
 * When it renders, this component's code was fetched from a different origin,
 * built by a different pipeline, at a different time, and is now running inside
 * the host's injector against the host's Angular. It reads records the host
 * wrote and writes records the host will refuse.
 */
@Component({
  selector: 'remote-editor',
  styleUrl: '../cards.css',
  template: `
    <div class="banner">
      <h2>Remote editor · draft schema v2 · wizard 0.2</h2>
      <p>
        build <code>{{ build.buildId }}</code> · stamped {{ build.builtAt }} ·
        {{
          federated
            ? 'fetched at runtime from a separate deployment'
            : 'running standalone'
        }}
      </p>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Read the host's v1 record</h3>
        <dl class="meta">
          <dt>Tests</dt>
          <dd>The migration chain running on read</dd>
          <dt>Enables</dt>
          <dd>An older build's record opens at this build's shape</dd>
          <dt>Without it</dt>
          <dd>
            <code>author</code> is still a string where this code expects
            <code>{{ '{' }} name, email {{ '}' }}</code>
          </dd>
        </dl>
        <p>
          Same key, newer schema. The envelope says v1, this build declares v2,
          so the migration runs on the way out — the host never had to know it
          would be needed.
        </p>
        <button (click)="readAsV2()">Read record as v2</button>
        @if (readOut(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong
            >{{ o.detail }}
          </div>
        }
        @if (migrated(); as m) {
          <pre>{{ m }}</pre>
        }
      </div>

      <div class="card">
        <h3>Write a v2 record</h3>
        <dl class="meta">
          <dt>Tests</dt>
          <dd>Writing an envelope an older reader can recognise</dd>
          <dt>Enables</dt>
          <dd>The host can tell this is from the future and decline</dd>
          <dt>Without it</dt>
          <dd>The host reads it as v1 and corrupts what it renders</dd>
        </dl>
        <p>
          Then go back to the host and read it — with protections on and then
          off. An older build cannot migrate downward, because the information
          it would need was never written.
        </p>
        <button (click)="writeV2()">Write v2 record</button>
        @if (writeOut(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong
            >{{ o.detail }}
          </div>
        }
      </div>

      <div class="card">
        <h3>Open the host's parked wizard on 0.2</h3>
        <dl class="meta">
          <dt>Tests</dt>
          <dd>Run envelope and payload schema, unwrapped in order</dd>
          <dt>Enables</dt>
          <dd>A draft parked under 0.1 resumes here, migrated</dd>
          <dt>Without it</dt>
          <dd>
            0.2's code reads 0.1's payload — <code>summary</code> is missing
          </dd>
        </dl>
        <p>
          Type into the wizard on the host, then read the draft here. Two
          schemas version separately on purpose: the run envelope belongs to the
          library, the payload belongs to you.
        </p>
        <button (click)="readDraft()">Read the parked draft</button>
        @if (draftOut(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong
            >{{ o.detail }}
          </div>
        }
        @if (draftData(); as d) {
          <pre>{{ d }}</pre>
          <div class="step">
            0.2 declares
            <strong>{{ stepCount }}</strong> steps ({{ stepNames }}) — the
            <code>review</code> step is the one 0.1 never had.
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .banner {
        background: #1e3a5f;
        color: #fff;
        border-radius: 14px;
        padding: 1rem 1.2rem;
        margin-bottom: 1.1rem;
      }
      .banner h2 {
        margin: 0 0 0.25rem;
        font-size: 1rem;
      }
      .banner p {
        margin: 0;
        opacity: 0.8;
        font-size: 0.76rem;
      }
      .banner code {
        background: rgba(255, 255, 255, 0.16);
        color: #fff;
      }
    `,
  ],
})
export class Editor {
  protected readonly build = BUILD_IDENTITY;

  /**
   * True when this module is rendering into a page it was not deployed with —
   * i.e. a host fetched it across the federation boundary.
   *
   * `import.meta.url` is the module's *own* URL, the only thing in scope that
   * knows where this code came from. `document.baseURI` is where the running
   * page was deployed. Comparing the two **directories** is what makes this
   * work under both serving modes:
   *
   *   standalone, two ports   module :4411/        base :4411/        → same
   *   federated,  two ports   module :4411/        base :4410/        → differ
   *   standalone, one origin  module :4420/remote/ base :4420/remote/ → same
   *   federated,  one origin  module :4420/remote/ base :4420/        → differ
   *
   * Comparing origins instead — the obvious first attempt — silently reports
   * "standalone" in the one-origin deployment, where the origins match by
   * construction and are therefore no evidence of anything.
   */
  protected readonly federated =
    new URL('.', import.meta.url).href !== new URL('.', document.baseURI).href;

  /** What 0.2 declares, read off the definition rather than asserted in prose. */
  protected readonly stepCount = Object.keys(wizardV2.steps).length;
  protected readonly stepNames = Object.keys(wizardV2.steps).join(' → ');

  protected readonly readOut = signal<Outcome | null>(null);
  protected readonly writeOut = signal<Outcome | null>(null);
  protected readonly migrated = signal<string | null>(null);
  protected readonly draftOut = signal<Outcome | null>(null);
  protected readonly draftData = signal<string | null>(null);

  /**
   * This build knows the schema one version further along than the host.
   * Built per call so the host's driver toggle (localStorage ↔ IndexedDB)
   * applies here too — if it did not, the two builds would be reading
   * different stores and every scenario would report an empty one.
   */
  private get store() {
    return storeOn(DraftSchemaV2);
  }

  /**
   * The parked run, read directly rather than through `injectWorkflow`.
   *
   * See the note on `wizardV2`: attaching would return the host's already-live
   * 0.1 run, because the runtime deduplicates by workflow id and the host got
   * there first. Reading the draft is what this build does on any page load
   * where it is the only one running.
   */
  private get runStore() {
    return storeOn(runSchema);
  }

  /** Mirrors the host's switch — the flag lives in the shared `@skew/core`. */
  private get guarded(): boolean {
    return !isSkewDisabled();
  }

  constructor() {
    // The host's guided walkthrough drives these same actions over a DOM
    // event channel — see `commands.ts`. It names an intent; this build
    // decides what that means under its own schema. Torn down with the
    // component so a stale listener never answers on its behalf.
    const stop = listenForCommands((action) => this.handleCommand(action));
    inject(DestroyRef).onDestroy(stop);
  }

  private async handleCommand(
    action: RemoteAction,
  ): Promise<Omit<RemoteResult, 'id'>> {
    switch (action) {
      case 'read-record-as-v2':
        return this.readAsV2();
      case 'write-v2-record':
        return this.writeV2();
      case 'read-parked-draft':
        return this.readDraft();
      case 'clear-record':
        await this.store.remove(DRAFT_KEY);
        this.readOut.set(null);
        this.writeOut.set(null);
        this.migrated.set(null);
        return {
          ok: true,
          headline: 'Cleared',
          detail: 'The shared record was removed.',
        };
      case 'register-schema': {
        // Contribute this build's chain — up AND down — to the registry both
        // bundles reach through the one shared @skew/core instance. From this
        // moment the v1-only host can downgrade a v2 record it could only
        // refuse before. Idempotent; a second registration of the same chain
        // is a no-op.
        registerSchema(DraftSchemaV2);
        trace(
          'ok',
          'editor',
          'registered skew-demo-draft v1 ↔ v2 with the shared registry',
          true,
        );
        return {
          ok: true,
          headline: 'Chain registered',
          detail:
            'This build contributed its v1 ↔ v2 steps (including the down direction) to the page-wide registry.',
          expectedVersion: DraftSchemaV2.version,
        };
      }
      default:
        return {
          ok: false,
          headline: 'Unknown command',
          detail: `This build does not know how to "${action}". It may be older than the host asking.`,
        };
    }
  }

  /**
   * The v1 → v2 migration, field by field.
   *
   * Read from the raw bytes rather than reconstructed, so "before" is what
   * was genuinely on disk. The distinction that matters is `migrated` (the
   * value came from somewhere real) versus `derived` (this build invented a
   * placeholder because v1 never carried the field) — collapsing those two
   * into "it worked" is what makes a guess look like a report.
   */
  private async describeMigration(after: DraftV2): Promise<FieldChange[]> {
    let before: Partial<Record<string, unknown>> = {};
    try {
      const raw = await rawAt(this.store.keyFor(DRAFT_KEY));
      const parsed = raw ? JSON.parse(raw) : null;
      before = (parsed?.payload ?? parsed ?? {}) as Record<string, unknown>;
    } catch {
      /* the table degrades to em-dashes rather than breaking the read */
    }

    const show = (v: unknown): string =>
      v === undefined
        ? '—'
        : typeof v === 'string'
          ? `"${v}"`
          : JSON.stringify(v);

    return [
      {
        name: 'id',
        before: show(before['id']),
        after: show(after.id),
        status: 'same',
      },
      {
        name: 'title',
        before: show(before['title']),
        after: show(after.title),
        status: 'same',
      },
      {
        name: 'author',
        before: show(before['author']),
        after: show(after.author),
        status: typeof before['author'] === 'string' ? 'migrated' : 'same',
      },
      {
        name: 'body',
        before: show(before['body']),
        after: show(after.body),
        status: 'same',
      },
      {
        name: 'summary',
        before: show(before['summary']),
        after: show(after.summary),
        status: before['summary'] === undefined ? 'derived' : 'same',
      },
    ];
  }

  protected async readAsV2(): Promise<Omit<RemoteResult, 'id'>> {
    trace(
      'step',
      'remote/read',
      `get("${DRAFT_KEY}") as v${DraftSchemaV2.version}`,
      this.guarded,
    );
    const result = await this.store.get(DRAFT_KEY);

    if (!result.ok) {
      const outcome = {
        ok: false,
        headline: `Failed — ${result.reason}`,
        detail:
          result.reason === 'invalid'
            ? 'Nothing has been written yet. Write a v1 record on the host first.'
            : result.message,
      };
      this.readOut.set(outcome);
      this.migrated.set(null);
      return outcome;
    }

    const raw = JSON.stringify(result.value, null, 2);
    const outcome = {
      ok: true,
      headline: result.migratedFrom
        ? `Migrated v${result.migratedFrom} → v${DraftSchemaV2.version}`
        : 'Already v2',
      detail: result.migratedFrom
        ? 'The bare author string became a structured value and summary was derived from the body — at the boundary, once, instead of defensively in every consumer.'
        : 'No migration was needed.',
    };
    this.readOut.set(outcome);
    this.migrated.set(raw);

    return {
      ...outcome,
      foundVersion: result.migratedFrom ?? DraftSchemaV2.version,
      expectedVersion: DraftSchemaV2.version,
      fields: result.migratedFrom
        ? await this.describeMigration(result.value)
        : undefined,
      // The stored payload as it actually is on disk, so the host's diff
      // compares against the bytes rather than a reconstruction of them.
      before: result.migratedFrom ? await this.storedPayload() : undefined,
      after: result.migratedFrom ? result.value : undefined,
      derivedPaths: result.derivedPaths,
      lossyPaths: result.lossyPaths,
      raw,
    };
  }

  /** The payload currently on disk, unwrapped from its envelope. */
  private async storedPayload(): Promise<unknown> {
    try {
      const raw = await rawAt(this.store.keyFor(DRAFT_KEY));
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed?.payload ?? parsed ?? undefined;
    } catch {
      return undefined;
    }
  }

  protected async writeV2(): Promise<Omit<RemoteResult, 'id'>> {
    trace(
      'step',
      'remote/write',
      this.guarded
        ? 'set() — wrapping as { v: 2, payload }'
        : 'set() — writing a bare object, no version recorded',
      this.guarded,
    );
    const record: DraftV2 = {
      id: 'demo-1',
      title: 'Third Sunday of Advent',
      author: { name: 'Rev. Anthony Russo', email: 'frrusso@example.org' },
      body: 'Rejoice in the Lord always; again I will say, rejoice.',
      summary: 'Gaudete Sunday.',
    };
    await this.store.set(DRAFT_KEY, record);

    const raw = (await rawAt(this.store.keyFor(DRAFT_KEY))) ?? '';
    const outcome = {
      ok: true,
      headline: this.guarded ? 'Written as v2' : 'Written with no envelope',
      detail: this.guarded
        ? 'Envelope { v: 2 }. The host will refuse this rather than mangle it.'
        : 'No version recorded. The host has no way to tell this is not its own v1 — which is exactly how it ends up rendering undefined.',
    };
    this.writeOut.set(outcome);

    return {
      ...outcome,
      foundVersion: this.guarded ? DraftSchemaV2.version : undefined,
      expectedVersion: DraftSchemaV2.version,
      raw: raw ? JSON.stringify(JSON.parse(raw), null, 2) : undefined,
    };
  }

  /**
   * Two unwraps, in order. The run envelope first — that's the library's
   * schema, and it tells us which step the user was on. Then the payload,
   * with *this* build's schema, which is where 0.1's shape becomes 0.2's.
   */
  protected async readDraft(): Promise<Omit<RemoteResult, 'id'>> {
    trace('step', 'remote/draft', 'unwrapping the run envelope', this.guarded);
    const run = await this.runStore.get(wizardV2.id);

    if (!run.ok) {
      const outcome = {
        ok: false,
        headline: `No draft — ${run.reason}`,
        detail:
          run.reason === 'invalid'
            ? 'Nothing parked yet. Type into the wizard on the host first.'
            : run.message,
      };
      this.draftOut.set(outcome);
      this.draftData.set(null);
      return outcome;
    }

    const payload = WizardDataSchemaV2.read(run.value.data);

    if (!payload.ok) {
      const outcome = {
        ok: false,
        headline: `Payload refused — ${payload.reason}`,
        detail:
          payload.reason === 'ahead'
            ? 'The draft was written by a build newer than this one. It is left untouched rather than opened at a shape this build would misread.'
            : payload.message,
      };
      this.draftOut.set(outcome);
      this.draftData.set(null);
      return outcome;
    }

    const data = payload.value as WizardDataV2;
    const raw = JSON.stringify(data, null, 2);
    const outcome = {
      ok: true,
      headline: payload.migratedFrom
        ? `Parked on "${run.value.current}" · payload migrated v${payload.migratedFrom} → v${WizardDataSchemaV2.version}`
        : `Parked on "${run.value.current}" · payload already current`,
      detail: payload.migratedFrom
        ? 'The host wrote this under 0.1, which had no summary field. It opens here with one, without the host ever knowing 0.2 exists.'
        : 'No migration was needed.',
    };
    this.draftOut.set(outcome);
    this.draftData.set(raw);

    return {
      ...outcome,
      foundVersion: payload.migratedFrom ?? WizardDataSchemaV2.version,
      expectedVersion: WizardDataSchemaV2.version,
      raw,
    };
  }
}
