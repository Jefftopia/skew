import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { createVersionedStore, webStorageDriver } from '@braid/skew';
import { injectWorkflow } from '@braid/angular-workflow';
import { DRAFT_KEY, DraftSchemaV2, type DraftV2, VERSIONS, wizardV2 } from '../domain';

interface Outcome {
  readonly ok: boolean;
  readonly headline: string;
  readonly detail: string;
}

/**
 * App 2 — data schema v2, workflow 0.2. Lives in its own lazy chunk.
 *
 * Reads the records App 1 wrote (migrating them forward), and resumes the
 * wizard draft App 1 parked under an older workflow.
 */
@Component({
  selector: 'app-demo-two',
  imports: [RouterLink],
  styles: [
    `
      :host { display: block; }
      .banner { background: #1E3A5F; color: #fff; border-radius: 14px;
                padding: 1rem 1.2rem; margin-bottom: 1.1rem; }
      .banner h2 { margin: 0 0 .2rem; font-size: 1rem; }
      .banner p { margin: 0; opacity: .75; font-size: .8rem; }
      .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
      .card { border: 1px solid #d8dee9; border-radius: 14px; padding: 1.1rem 1.2rem; background: #fff; }
      .card h3 { margin: 0 0 .35rem; font-size: .95rem; }
      .card p { margin: 0 0 .9rem; color: #5b6779; font-size: .82rem; line-height: 1.5; }
      button { border: 0; border-radius: 9px; padding: .5rem .9rem; font-weight: 700;
               font-size: .76rem; cursor: pointer; background: #1E3A5F; color: #fff; }
      .verdict { margin-top: .85rem; padding: .7rem .8rem; border-radius: 10px; font-size: .78rem; }
      .verdict.ok { background: #e7f6ec; border: 1px solid #a7d8b8; color: #14532d; }
      .verdict.bad { background: #fdecec; border: 1px solid #f0b4b4; color: #7f1d1d; }
      .verdict strong { display: block; margin-bottom: .2rem; }
      pre { background: #f2f5f9; border-radius: 8px; padding: .6rem .7rem;
            font-size: .72rem; overflow-x: auto; margin: .6rem 0 0; }
      .step { font-size: .72rem; color: #5b6779; margin-top: .5rem; }
      .link { display: inline-block; margin-top: 1rem; font-size: .78rem; font-weight: 700; color: #1E3A5F; }
    `,
  ],
  template: `
    <div class="banner">
      <h2>App 2 · data v{{ v.appTwo.data }} · workflow {{ v.appTwo.workflow }}</h2>
      <p>Loaded as a separate chunk from App 1.</p>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Read App 1's v1 record</h3>
        <p>Same storage key, newer schema. The record migrates forward on read.</p>
        <button (click)="readAsV2()">Read record as v2</button>
        @if (readOut(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong>{{ o.detail }}
          </div>
        }
        @if (migrated(); as m) {
          <pre>{{ m }}</pre>
        }
      </div>

      <div class="card">
        <h3>Write a v2 record</h3>
        <p>Then go back to App 1 and read it — an older build cannot.</p>
        <button (click)="writeV2()">Write v2 record</button>
        @if (writeOut(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong>{{ o.detail }}
          </div>
        }
      </div>

      <div class="card">
        <h3>Resume the wizard on 0.2</h3>
        <p>
          The draft App 1 saved under workflow 0.1.123 opens here, migrated —
          and 0.2 adds a <code>review</code> step that 0.1.123 never had.
        </p>
        <div class="step">
          title: <strong>{{ flow.data().title || '—' }}</strong><br />
          step: <strong>{{ flow.current() }}</strong> ·
          {{ flow.progress().done }}/{{ flow.progress().total }} steps
        </div>
      </div>
    </div>

    <a class="link" routerLink="/">&larr; Back to App 1</a>
  `,
})
export class AppTwo {
  protected readonly v = VERSIONS;
  protected readonly flow = injectWorkflow(wizardV2);

  protected readonly readOut = signal<Outcome | null>(null);
  protected readonly writeOut = signal<Outcome | null>(null);
  protected readonly migrated = signal<string | null>(null);

  /** App 2 knows the schema one version further along. */
  private readonly store = createVersionedStore(DraftSchemaV2, {
    driver: webStorageDriver('local'),
  });

  protected async readAsV2(): Promise<void> {
    const result = await this.store.get(DRAFT_KEY);

    if (!result.ok) {
      this.readOut.set({ ok: false, headline: `Failed — ${result.reason}`, detail: result.message });
      this.migrated.set(null);
      return;
    }

    this.readOut.set({
      ok: true,
      headline: result.migratedFrom
        ? `Migrated v${result.migratedFrom} → v${DraftSchemaV2.version}`
        : 'Already v2',
      detail: result.migratedFrom
        ? 'The bare author string became a structured value, and summary was derived from the body.'
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
      detail: 'Envelope { v: 2 }. App 1 will refuse this rather than mangle it.',
    });
  }
}
