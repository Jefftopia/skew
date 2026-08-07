import { Component, signal } from '@angular/core';
import { createVersionedStore, webStorageDriver } from '@skew/core';
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
        <p>
          Same key, same origin, newer schema. The envelope says v1, this build
          declares v2, so the migration runs on the way out — the host never had
          to know it would be needed.
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
        <p>
          Then go back to the host and read it. An older build cannot migrate
          downward — the information it would need was never written — so it
          refuses instead of guessing.
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
        <p>
          Type into the wizard on the host, then read the draft here. The run
          envelope unwraps, then the payload migrates from 0.1's shape to 0.2's
          — two schemas, versioned separately on purpose.
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

  /** This build knows the schema one version further along than the host. */
  private readonly store = createVersionedStore(DraftSchemaV2, {
    driver: webStorageDriver('local'),
  });

  /**
   * The parked run, read directly rather than through `injectWorkflow`.
   *
   * See the note on `wizardV2`: attaching would return the host's already-live
   * 0.1 run, because the runtime deduplicates by workflow id and the host got
   * there first. Reading the draft is what this build does on any page load
   * where it is the only one running.
   */
  private readonly runStore = createVersionedStore(runSchema, {
    driver: webStorageDriver('local'),
  });

  protected async readAsV2(): Promise<void> {
    const result = await this.store.get(DRAFT_KEY);

    if (!result.ok) {
      this.readOut.set({
        ok: false,
        headline: `Failed — ${result.reason}`,
        detail:
          result.reason === 'invalid'
            ? 'Nothing has been written yet. Write a v1 record on the host first.'
            : result.message,
      });
      this.migrated.set(null);
      return;
    }

    this.readOut.set({
      ok: true,
      headline: result.migratedFrom
        ? `Migrated v${result.migratedFrom} → v${DraftSchemaV2.version}`
        : 'Already v2',
      detail: result.migratedFrom
        ? 'The bare author string became a structured value and summary was derived from the body — at the boundary, once, instead of defensively in every consumer.'
        : 'No migration was needed.',
    });
    this.migrated.set(JSON.stringify(result.value, null, 2));
  }

  protected async writeV2(): Promise<void> {
    const record: DraftV2 = {
      id: 'demo-1',
      title: 'Third Sunday of Advent',
      author: { name: 'Rev. Anthony Russo', email: 'frrusso@example.org' },
      body: 'Rejoice in the Lord always; again I will say, rejoice.',
      summary: 'Gaudete Sunday.',
    };
    await this.store.set(DRAFT_KEY, record);
    this.writeOut.set({
      ok: true,
      headline: 'Written as v2',
      detail:
        'Envelope { v: 2 }. The host will refuse this rather than mangle it.',
    });
  }

  /**
   * Two unwraps, in order. The run envelope first — that's the library's
   * schema, and it tells us which step the user was on. Then the payload,
   * with *this* build's schema, which is where 0.1's shape becomes 0.2's.
   */
  protected async readDraft(): Promise<void> {
    const run = await this.runStore.get(wizardV2.id);

    if (!run.ok) {
      this.draftOut.set({
        ok: false,
        headline: `No draft — ${run.reason}`,
        detail:
          run.reason === 'invalid'
            ? 'Nothing parked yet. Type into the wizard on the host first.'
            : run.message,
      });
      this.draftData.set(null);
      return;
    }

    const payload = WizardDataSchemaV2.read(run.value.data);

    if (!payload.ok) {
      this.draftOut.set({
        ok: false,
        headline: `Payload refused — ${payload.reason}`,
        detail:
          payload.reason === 'ahead'
            ? 'The draft was written by a build newer than this one. It is left untouched rather than opened at a shape this build would misread.'
            : payload.message,
      });
      this.draftData.set(null);
      return;
    }

    const data = payload.value as WizardDataV2;
    this.draftOut.set({
      ok: true,
      headline: payload.migratedFrom
        ? `Parked on "${run.value.current}" · payload migrated v${payload.migratedFrom} → v${WizardDataSchemaV2.version}`
        : `Parked on "${run.value.current}" · payload already current`,
      detail: payload.migratedFrom
        ? 'The host wrote this under 0.1, which had no summary field. It opens here with one, without the host ever knowing 0.2 exists.'
        : 'No migration was needed.',
    });
    this.draftData.set(JSON.stringify(data, null, 2));
  }
}
