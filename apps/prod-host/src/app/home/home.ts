import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { createVersionedStore, webStorageDriver } from '@skew/core';
import { injectWorkflow } from '@skew/angular-workflow';
import { DRAFT_KEY, DraftSchemaV1, type DraftV1, wizardV1 } from '../domain';

interface Outcome {
  readonly ok: boolean;
  readonly headline: string;
  readonly detail: string;
}

@Component({
  selector: 'host-home',
  imports: [RouterLink],
  styleUrl: '../cards.css',
  template: `
    <div class="grid">
      <div class="card">
        <h3>1 · Write a v1 record</h3>
        <p>
          The host understands draft schema <strong>v1</strong>, where
          <code>author</code> is a bare string. The record goes to storage
          wrapped in an envelope that names its version.
        </p>
        <button (click)="writeV1()">Write v1 record</button>
        @if (wrote(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong
            >{{ o.detail }}
          </div>
        }
      </div>

      <div class="card">
        <h3>2 · Read it back</h3>
        <p>
          Harmless until the remote has written. The remote ships schema
          <strong>v2</strong>; once it saves, this read is data
          <em>from the future</em> and cannot be migrated downward.
        </p>
        <button class="ghost" (click)="readAsV1()">Read record as v1</button>
        @if (read(); as o) {
          <div class="verdict" [class.ok]="o.ok" [class.bad]="!o.ok">
            <strong>{{ o.headline }}</strong
            >{{ o.detail }}
          </div>
        }
        @if (raw(); as r) {
          <pre>{{ r }}</pre>
        }
      </div>

      <div class="card">
        <h3>3 · Start a wizard on 0.1</h3>
        <p>
          Two steps, no review. Type something, then open the remote — the same
          draft resumes on its newer workflow.
        </p>
        <div class="wizard">
          <input
            placeholder="Title"
            [value]="flow.data().title"
            (input)="flow.patch({ title: $any($event.target).value })"
          />
          <input
            placeholder="Body"
            [value]="flow.data().body"
            (input)="flow.patch({ body: $any($event.target).value })"
          />
          <div class="step">
            step <strong>{{ flow.current() }}</strong> ·
            {{ flow.progress().done }}/{{ flow.progress().total }} · draft
            <strong>{{ flow.savedLocally() }}</strong>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>4 · Cross the federation boundary</h3>
        <p>
          The remote is fetched from another origin at runtime. Redeploy it
          while this tab stays open and the file names this tab is holding stop
          existing — a real 404 for a real module.
        </p>
        <pre>npm run demo:prod:redeploy-remote</pre>
        <p style="margin-top:.7rem">Then click through without reloading:</p>
        <a routerLink="/editor"><button>Open the remote editor</button></a>
      </div>
    </div>
  `,
})
export class Home {
  protected readonly flow = injectWorkflow(wizardV1);

  protected readonly wrote = signal<Outcome | null>(null);
  protected readonly read = signal<Outcome | null>(null);
  protected readonly raw = signal<string | null>(null);

  /** The host only ever knows v1. It has never heard of v2. */
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
    this.wrote.set({
      ok: true,
      headline: 'Written as v1',
      detail: `Envelope { v: 1 } — author is the string "${record.author}".`,
    });
    this.read.set(null);
    this.raw.set(null);
  }

  protected async readAsV1(): Promise<void> {
    const result = await this.store.get(DRAFT_KEY);

    if (result.ok) {
      this.read.set({
        ok: true,
        headline: `Read at v${DraftSchemaV1.version}`,
        detail: result.migratedFrom
          ? `Migrated up from v${result.migratedFrom}.`
          : 'Already current — nothing to migrate.',
      });
      this.raw.set(JSON.stringify(result.value, null, 2));
      return;
    }

    this.read.set({
      ok: false,
      headline: `Refused — ${result.reason}`,
      detail:
        result.reason === 'ahead'
          ? `The stored record is v${result.found}; this build understands v${result.expected}. ` +
            'Migrating downward would silently drop everything v2 added, so the read fails at ' +
            'the boundary instead of handing a half-empty object to a template. Without the ' +
            'envelope this would have been a cast, and the failure would surface as `undefined` ' +
            'somewhere far away from the cause.'
          : result.message,
    });
    this.raw.set(null);
  }
}
