import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { createVersionedStore, webStorageDriver } from '@braidlabs/skew';
import { injectWorkflow } from '@braidlabs/angular-workflow';
import { DRAFT_KEY, DraftSchemaV1, type DraftV1, VERSIONS, wizardV1 } from '../domain';

interface Outcome {
  readonly ok: boolean;
  readonly headline: string;
  readonly detail: string;
}

/**
 * App 1 — data schema v1, workflow 0.1.123.
 *
 * Writes records and drafts that App 2 will later read, and demonstrates what
 * happens when it tries to read something App 2 wrote.
 */
@Component({
  selector: 'app-demo-one',
  imports: [RouterLink],
  styles: [
    `
      :host { display: block; }
      .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
      .card { border: 1px solid #d8dee9; border-radius: 14px; padding: 1.1rem 1.2rem; background: #fff; }
      .card h3 { margin: 0 0 .35rem; font-size: .95rem; }
      .card p { margin: 0 0 .9rem; color: #5b6779; font-size: .82rem; line-height: 1.5; }
      button { border: 0; border-radius: 9px; padding: .5rem .9rem; font-weight: 700;
               font-size: .76rem; cursor: pointer; background: #1E3A5F; color: #fff; }
      button.ghost { background: #eef2f7; color: #1E3A5F; }
      .verdict { margin-top: .85rem; padding: .7rem .8rem; border-radius: 10px; font-size: .78rem; }
      .verdict.ok { background: #e7f6ec; border: 1px solid #a7d8b8; color: #14532d; }
      .verdict.bad { background: #fdecec; border: 1px solid #f0b4b4; color: #7f1d1d; }
      .verdict strong { display: block; margin-bottom: .2rem; }
      code { background: #f2f5f9; padding: .1rem .35rem; border-radius: 5px; font-size: .74rem; }
      .wizard { margin-top: .6rem; display: grid; gap: .5rem; }
      input { padding: .5rem .6rem; border: 1px solid #d8dee9; border-radius: 8px; font: inherit; font-size: .8rem; }
      .step { font-size: .72rem; color: #5b6779; }
      .link { display: inline-block; margin-top: .6rem; font-size: .78rem; font-weight: 700; color: #1E3A5F; }
    `,
  ],
  template: `
    <div class="grid">
      <!-- 1 -->
      <div class="card">
        <h3>1 · Write a v{{ v.appOne.data }} record</h3>
        <p>App 1 saves a draft under schema v1, where <code>author</code> is a bare string.</p>
        <button (click)="writeV1()">Write v1 record</button>
        @if (write1(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong>{{ o.detail }}
          </div>
        }
      </div>

      <!-- 2 -->
      <div class="card">
        <h3>2 · Read what App 2 wrote</h3>
        <p>
          App 2 writes schema v2. App 1 only knows v1, so this read is data
          <em>from the future</em> — it cannot be migrated downward.
        </p>
        <button class="ghost" (click)="readAsV1()">Read record as v1</button>
        @if (read1(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong>{{ o.detail }}
          </div>
        }
      </div>

      <!-- 3 -->
      <div class="card">
        <h3>3 · Start a wizard on {{ v.appOne.workflow }}</h3>
        <p>Fill this in, then open App 2 — the same draft resumes on workflow 0.2.</p>
        <div class="wizard">
          <input placeholder="Title" [value]="flow.data().title"
                 (input)="flow.patch({ title: $any($event.target).value })" />
          <input placeholder="Body" [value]="flow.data().body"
                 (input)="flow.patch({ body: $any($event.target).value })" />
          <div class="step">
            step <strong>{{ flow.current() }}</strong> ·
            {{ flow.progress().done }}/{{ flow.progress().total }} ·
            draft {{ flow.savedLocally() }}
          </div>
        </div>
      </div>

      <!-- 4 -->
      <div class="card">
        <h3>4 · Load App 2</h3>
        <p>
          A real lazy chunk. Use the simulator above to purge it, or to make the
          origin serve a stale manifest, before clicking.
        </p>
        <a class="link" routerLink="/app-two">Open App 2 &rarr;</a>
      </div>
    </div>
  `,
})
export class AppOne {
  protected readonly v = VERSIONS;
  protected readonly flow = injectWorkflow(wizardV1);

  protected readonly write1 = signal<Outcome | null>(null);
  protected readonly read1 = signal<Outcome | null>(null);

  /** App 1 only ever knows v1 of the schema. */
  private readonly store = createVersionedStore(DraftSchemaV1, {
    driver: webStorageDriver('local'),
  });

  protected async writeV1(): Promise<void> {
    const record: DraftV1 = {
      id: 'demo-1',
      title: 'Second Sunday of Advent',
      author: 'Rev. Bernard J. Miller',
      body: 'Prepare the way of the Lord, make straight his paths.',
    };
    await this.store.set(DRAFT_KEY, record);
    this.write1.set({
      ok: true,
      headline: 'Written as v1',
      detail: `Envelope { v: 1 } · author is the string "${record.author}".`,
    });
    this.read1.set(null);
  }

  protected async readAsV1(): Promise<void> {
    const result = await this.store.get(DRAFT_KEY);

    if (result.ok) {
      this.read1.set({
        ok: true,
        headline: `Read at v${DraftSchemaV1.version}`,
        detail: result.migratedFrom
          ? `Migrated from v${result.migratedFrom}.`
          : 'Already current — no migration needed.',
      });
      return;
    }

    this.read1.set({
      ok: false,
      headline: `Refused — ${result.reason}`,
      detail:
        result.reason === 'ahead'
          ? `The record is v${result.found}; this build understands v${result.expected}. ` +
            'Migrating downward would silently drop the fields v2 added, so the read fails ' +
            'instead of corrupting the record.'
          : result.message,
    });
  }
}
