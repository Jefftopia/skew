import { Component, computed, inject, signal } from '@angular/core';
import { DATA_OPTIONS } from '@skewkit/angular-data';
import { createDataClient, createOutbox, createRecordStore, type DataClient, type QueryState } from '@skewkit/data';
import { registerSchema, versioned } from '@skewkit/core';
import { DemoPanel } from './panel';

/**
 * Acts two and four — the shared cache, invalidation, and skew.
 *
 * The two apps here are two `DataClient`s over **one driver**, which is what two independently
 * deployed applications sharing an origin's storage actually looks like. They are not told about
 * each other.
 */

interface CharacterV1 {
  id: string;
  name: string;
  homeworld: string;
  starships: number;
}
/** The older shape: a build from before `starships` existed. */
type CharacterV0 = Omit<CharacterV1, 'starships'>;

const CharacterOld = versioned<CharacterV0>('demo.character');
const CharacterNew = versioned<CharacterV0>('demo.character').next<CharacterV1>('count starships', {
  up: (old) => ({ ...old, starships: 0 }),
  down: ({ starships: _s, ...rest }) => rest,
  derives: ['starships'],
  lossy: ['starships'],
});

/**
 * A **third** version, from a build that has not shipped to everyone yet — and deliberately with no
 * `down`.
 *
 * That single omission is what makes it unreachable from below: projecting a record backwards needs
 * every intervening step to know how to walk back, and this one does not. A reader at v2 meeting a
 * v3 record is not looking at corruption or at a missing record. It is looking at data from the
 * future, and the only honest answers are to say so or to go and ask for a version it can read.
 */
interface CharacterV2Plus extends CharacterV1 {
  faction: string;
}
const CharacterFuture = CharacterNew.next<CharacterV2Plus>('name the faction', (old) => ({
  ...old,
  faction: 'unaligned',
}));

/**
 * Contributes the v1 → v2 step to the shared registry, which is what lets the *older* reader
 * project a newer record down. The `down` step lives in the chain that introduced the version, so
 * without this the older app gets `ahead` and nothing else.
 *
 * Both apps are in one JavaScript context here. Across Braid realms the registry is per-realm, so
 * a fragment two versions behind must ship the down-steps itself — see the shared state plan.
 */
registerSchema(CharacterNew);

@Component({
  selector: 'demo-data',
  standalone: true,
  imports: [DemoPanel],
  template: `
    <h2>Shared data</h2>

    <demo-panel
      [n]="4"
      claim="Both apps show this character. They fetched it once between them."
      proves="A cache that lives in storage, not in one app's memory — so it is shared"
    >
      <div class="row">
        @for (id of ids; track id) {
          <button type="button" [class.on]="selected() === id" (click)="select(id)">{{ id }}</button>
        }
      </div>

      <p class="count">
        Times the network was actually hit: <strong>{{ fetches() }}</strong>
        <span class="sub">— for {{ views() }} views across two apps</span>
      </p>

      <div class="apps">
        <div class="app">
          <span class="tag a">app one</span>
          {{ render(appOne()) }}
        </div>
        <div class="app">
          <span class="tag b">app two</span>
          {{ render(appTwo()) }}
          @if (appTwo().fromCache) {
            <span class="badge">from the shared cache</span>
          }
        </div>
      </div>
      <p class="hint">
        Click a character, then click it again after visiting another. The counter does not move:
        the second app reads what the first stored, and simultaneous asks are deduplicated by a lock
        that works across realms.
      </p>
    </demo-panel>

    <demo-panel
      [n]="5"
      claim="Rename it in one app. The other app updates itself."
      proves="Tag invalidation that reaches every app on the page, not just the one that mutated"
    >
      <div class="row">
        <input [value]="draft()" (input)="draft.set(asValue($event))" aria-label="New name" />
        <button type="button" (click)="rename()">Rename in app one</button>
      </div>
      <p class="hint">
        App two never hears about the edit directly. It declared a dependency on
        <code>character#{{ selected() }}</code>, and that tag going stale is what refreshes it.
      </p>
    </demo-panel>

    <demo-panel
      [n]="6"
      claim="Your edit shows instantly. The server takes two seconds."
      proves="The optimistic overlay — derived from the queue, so it cannot disagree with it"
    >
      <div class="row">
        <input [value]="edit()" (input)="edit.set(asValue($event))" aria-label="New name" />
        <button type="button" (click)="submitSlow()" [disabled]="working()">Rename against a slow server</button>
      </div>

      <p class="count">
        {{ render(appOne()) }}
        @if (appOne().pending) {
          <span class="badge warn">pending — not yet sent</span>
        } @else {
          <span class="badge">confirmed</span>
        }
      </p>

      <p class="hint">
        The name changes before the request is made, and the badge says so. Nothing was written to a
        second "optimistic" store to make that happen: the queued entry carries what it predicts, and
        every reader derives <code>confirmed ⊕ pending</code>. Rolling back is deleting the entry —
        there is no undo record that can drift out of agreement with the queue.
      </p>
    </demo-panel>

    <demo-panel
      [n]="7"
      claim="The server disagreed with your edit, so we told you."
      proves="onConflict: 'raise' — the default, because the silent version edits the screen under you"
    >
      <div class="row">
        <input [value]="edit()" (input)="edit.set(asValue($event))" aria-label="New name" />
        <button type="button" (click)="submitRewritten()" [disabled]="working()">
          Submit to a server that rewrites it
        </button>
      </div>

      @if (appOne().conflict; as conflict) {
        <div class="apps">
          <div class="app">
            <span class="tag a">you submitted</span>
            {{ nameOf(conflict.expected) }}
          </div>
          <div class="app">
            <span class="tag b">the server stored</span>
            {{ nameOf(conflict.actual) }}
          </div>
        </div>
        <div class="row">
          <span class="state">disagreed about: {{ conflict.paths.join(', ') }}</span>
          <button type="button" (click)="dismissConflict()">Got it</button>
        </div>
      } @else {
        <p class="count">
          No conflict outstanding. <span class="sub">— submit above; this server upper-cases names</span>
        </p>
      }

      <p class="hint">
        The stored record is the server's either way: you cannot make a server hold your value
        without another mutation, so there is no client-wins option to offer. What is configurable is
        whether the user is <em>told</em> — and silence is the option you opt into, not the default.
      </p>
    </demo-panel>

    <h2>Skew — the part nothing else does</h2>

    <demo-panel
      [n]="12"
      claim="App two is a version behind. It still reads the record, minus what it cannot understand."
      proves="Per-reader projection — one stored record, two contract versions, both correct"
    >
      <div class="row">
        <button type="button" (click)="toggleVersion()">
          {{ behind() ? 'Bring app two up to date' : 'Put app two a version behind' }}
        </button>
        <span class="state">app two reads v{{ behind() ? 1 : 2 }}</span>
      </div>

      <div class="apps">
        <div class="app">
          <span class="tag a">app one · v2</span>
          {{ render(appOne()) }}
        </div>
        <div class="app">
          <span class="tag b">app two · v{{ behind() ? 1 : 2 }}</span>
          {{ render(appTwo()) }}
          @if (appTwo().downgradedFrom) {
            <span class="badge warn">
              projected down from v{{ appTwo().downgradedFrom }} — dropped {{ appTwo().lossyPaths.join(', ') }}
            </span>
          }
        </div>
      </div>
      <p class="hint">
        Nothing was refetched and nothing was duplicated. One record on disk, read through two
        different contract chains.
      </p>
    </demo-panel>

    <demo-panel
      [n]="13"
      claim="This field is a guess, not something the server said."
      proves="Provenance — a reader can tell a migration's guess from reported data"
    >
      @if (guessed().length > 0) {
        <p class="count">
          Guessed by a migration: <strong>{{ guessed().join(', ') }}</strong>
        </p>
      } @else {
        <p class="count">
          Nothing is a guess right now.
          <span class="sub">— put app two a version behind, then bring it back up to date</span>
        </p>
      }
      <p class="hint">
        When an older record is migrated <em>up</em>, the fields the older shape never carried are
        filled by the migration. A component that cannot tell those apart is trusting a guess — this
        is why the value travels with its provenance rather than alone.
      </p>
    </demo-panel>

    <demo-panel
      [n]="14"
      claim="This app is too far behind to read it, so it refetched instead of guessing."
      proves="A read that cannot be projected refuses, names why, and recovers — rather than inventing a value"
    >
      <div class="row">
        <button type="button" (click)="writeFromTheFuture()">Write this record from a v3 build</button>
        <span class="state">app three reads v{{ readerVersion }}</span>
      </div>

      <div class="apps">
        <div class="app">
          <span class="tag c">app three · v{{ readerVersion }}</span>
          {{ render(appThree()) }}
          @if (aheadOf()) {
            <span class="badge warn">ahead — the stored record is v3, which this reader cannot project down</span>
          }
          @if (refetched()) {
            <span class="badge">refetched at v{{ readerVersion }}</span>
          }
        </div>
      </div>

      <p class="count">
        Times app three went back to the network: <strong>{{ aheadFetches() }}</strong>
      </p>
      <p class="hint">
        The v3 step declares no way back, so nothing can project its records down — which is what a
        retired version looks like from below. Notice what did <em>not</em> happen: the record was
        not discarded as corrupt, and no field was guessed. The reader said <code>ahead</code>, and
        asked the server for a version it understands.
      </p>
    </demo-panel>
  `,
  styles: `
    :host { display: block; }
    h2 { font-size: 1.05rem; margin: 1.4rem 0 0.6rem; }
    .row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    button { font: inherit; padding: 0.3rem 0.7rem; border: 1px solid #cbd5e1; border-radius: 5px; background: #f8fafc; cursor: pointer; }
    button.on { background: #0ea5e9; color: #fff; border-color: #0ea5e9; }
    input { flex: 1; min-width: 10rem; padding: 0.35rem 0.5rem; border: 1px solid #cbd5e1; border-radius: 5px; font: inherit; }
    .count { margin: 0; font-size: 0.88rem; }
    .sub { color: #64748b; font-size: 0.8rem; font-weight: 400; }
    .state { font-size: 0.82rem; color: #475569; }
    .apps { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 0.5rem; }
    .app { border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.5rem 0.6rem; font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.3rem; }
    .tag { font-size: 0.7rem; border-radius: 999px; padding: 0.1rem 0.45rem; align-self: flex-start; color: #fff; }
    .tag.a { background: #0ea5e9; }
    .tag.b { background: #7c3aed; }
    .tag.c { background: #b45309; }
    .badge { font-size: 0.72rem; border: 1px solid #16a34a; color: #16a34a; border-radius: 999px; padding: 0 0.45rem; align-self: flex-start; }
    .badge.warn { border-color: #b45309; color: #b45309; }
    .hint { margin: 0; font-size: 0.82rem; color: #64748b; line-height: 1.45; }
    code { font-size: 0.8rem; }
  `,
})
export class DemoData {
  private readonly options = inject(DATA_OPTIONS);

  readonly ids = ['1', '2', '3', '4', '5'];
  readonly selected = signal('1');
  readonly draft = signal('Luke Starkiller');
  /** Panels 6 and 7 share a draft: they are the same edit, sent to two differently-behaved servers. */
  readonly edit = signal('Luke Starkiller');
  readonly working = signal(false);
  readonly behind = signal(false);
  readonly fetches = signal(0);
  readonly views = signal(0);

  readonly appOne = signal<QueryState<CharacterV1>>(emptyState());
  readonly appTwo = signal<QueryState<CharacterV0 | CharacterV1>>(emptyState());

  /** Panel 14's reader: pinned at v2, which is one version below what the writer will use. */
  readonly readerVersion = CharacterNew.version;
  readonly appThree = signal<QueryState<CharacterV1>>(emptyState());
  readonly aheadFetches = signal(0);
  readonly aheadOf = signal(false);
  readonly refetched = computed(() => this.aheadOf() && this.appThree().data !== undefined);

  /** Fields this reader received as a migration's guess rather than as reported data. */
  readonly guessed = computed(() => this.appTwo().derivedPaths);

  private readonly clientOne: DataClient;
  private readonly clientTwo: DataClient;
  private readonly clientThree: DataClient;
  private aheadDisposers: (() => void)[] = [];
  private disposers: (() => void)[] = [];

  constructor() {
    // Two clients, one driver. That is two independently deployed apps sharing an origin's
    // storage — the shared cache is a property of *where* it lives, not of any coordination.
    const shared = {
      driver: this.options.driver,
      partition: () => 'demo',
      collection: 'demo-entities',
      onFetch: () => this.fetches.update((n) => n + 1),
    };
    // Only app one writes, so only it needs the queue. App two still sees app one's unsent edits:
    // the overlay comes off shared storage, not out of the writer's memory.
    this.clientOne = createDataClient({
      ...shared,
      outbox: createOutbox({ driver: this.options.driver, owner: 'demo-app-one', collection: 'demo-outbox' }),
    });
    this.clientTwo = createDataClient(shared);
    // A third app, pinned a version behind the writer in panel 14. Its own fetch counter, because
    // "it went back to the network" is that panel's entire proof.
    this.clientThree = createDataClient({
      ...shared,
      onFetch: () => this.aheadFetches.update((n) => n + 1),
    });

    this.watch();
    this.watchAhead();
  }

  select(id: string): void {
    this.selected.set(id);
    this.watch();
  }

  /**
   * Switches which contract version app two reads, and re-subscribes.
   *
   * The re-subscribe is the whole operation: a query captures its schema when it is created, so
   * flipping a signal nothing re-reads changes the label and not the reader.
   */
  toggleVersion(): void {
    this.behind.update((behind) => !behind);
    this.watch();
  }

  async rename(): Promise<void> {
    await fetch(`/api/demo/characters/${this.selected()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: this.draft() }),
    });
    // App two is never told. It declared a dependency on this tag, and that is the whole channel.
    this.clientOne.invalidate(`character#${this.selected()}`);
  }

  /** Panel 6: a two-second server, so the gap between "shown" and "sent" is visible. */
  async submitSlow(): Promise<void> {
    await this.write({ delayMs: 2000, rewrite: false });
  }

  /** Panel 7: a server that accepts the write and stores something else. */
  async submitRewritten(): Promise<void> {
    await this.write({ delayMs: 0, rewrite: true });
  }

  dismissConflict(): void {
    this.clientOne.acknowledgeConflict(`character:${this.selected()}`);
  }

  /**
   * Writes the record as a v3 build would, then restarts the v2 reader.
   *
   * The restart is the honest way to show this: a reader that is already subscribed learns about
   * the write through invalidation, which forces a fetch and so never consults the stored record at
   * all. A fresh reader — a reload, another tab, a fragment mounting late — reads storage first, and
   * that is the moment the version gap is discovered.
   */
  async writeFromTheFuture(): Promise<void> {
    const store = createRecordStore<CharacterV2Plus>({
      driver: this.options.driver,
      collection: 'demo-entities',
      schema: CharacterFuture,
    });

    const current = (this.appOne().data ?? {
      id: this.selected(),
      name: 'Unknown',
      homeworld: 'Unknown',
      starships: 0,
    }) as CharacterV1;

    await store.put({
      id: `character:${this.selected()}`,
      partition: 'demo',
      value: { ...current, faction: 'rebel alliance' },
    });

    this.watchAhead();
  }

  asValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  nameOf(character: CharacterV1): string {
    return character?.name ?? '—';
  }

  render(state: QueryState<CharacterV0 | CharacterV1>): string {
    if (state.status === 'loading') return 'loading…';
    if (!state.data) return state.status === 'error' ? 'unavailable' : '—';
    const character = state.data as CharacterV1;
    return `${character.name} · ${character.homeworld}` + (character.starships === undefined ? '' : ` · ${character.starships} starships`);
  }

  /**
   * The write behind panels 6 and 7 — one mutation, two server behaviours.
   *
   * The panels differ only in how the server is told to behave, which is the honest way to show
   * that the overlay and the conflict report are the same mechanism seen twice: a write whose
   * prediction held, and one whose prediction did not.
   */
  private async write(behavior: { delayMs: number; rewrite: boolean }): Promise<void> {
    const id = this.selected();
    const name = this.edit();

    this.working.set(true);
    try {
      await this.setBehavior(behavior);
      await this.clientOne.mutate<CharacterV1>({
        key: `character:${id}`,
        schema: CharacterNew,
        mutationId: 'demo.character.rename',
        input: { id, name },
        patch: { name },
        tags: [`character#${id}`],
        send: async () =>
          (
            await fetch(`/api/demo/characters/${id}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            })
          ).json(),
      });
    } finally {
      // Left switched on, the next panel's server would misbehave for reasons its claim never
      // mentions — a demo that lies by leftover state is worse than one that shows less.
      await this.setBehavior({ delayMs: 0, rewrite: false });
      this.working.set(false);
    }
  }

  private async setBehavior(behavior: { delayMs: number; rewrite: boolean }): Promise<void> {
    await fetch('/api/demo/behavior', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(behavior),
    });
  }

  /** (Re)subscribes both apps to the selected character. */
  private watch(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.views.update((n) => n + 2);

    const id = this.selected();
    const fetcher = async () => (await fetch(`/api/demo/characters/${id}`)).json();

    // `staleWhileRevalidate: false` so a cache hit really does not go back to the network — which
    // is what makes the counter above a claim rather than a decoration. Invalidation still forces a
    // refetch, so panel 5 keeps working.
    const one = this.clientOne.query<CharacterV1>({
      key: `character:${id}`,
      tags: [`character#${id}`],
      schema: CharacterNew,
      fetch: fetcher,
      staleWhileRevalidate: false,
    });
    const two = this.clientTwo.query<CharacterV0 | CharacterV1>({
      key: `character:${id}`,
      tags: [`character#${id}`],
      schema: (this.behind() ? CharacterOld : CharacterNew) as never,
      fetch: fetcher,
      staleWhileRevalidate: false,
    });

    this.disposers.push(one.subscribe((s) => this.appOne.set(s)), () => one.dispose());
    this.disposers.push(two.subscribe((s) => this.appTwo.set(s)), () => two.dispose());
  }

  /** (Re)subscribes panel 14's reader, which is what makes it read storage before the network. */
  private watchAhead(): void {
    for (const dispose of this.aheadDisposers) dispose();
    this.aheadDisposers = [];
    this.aheadOf.set(false);

    const id = this.selected();
    const query = this.clientThree.query<CharacterV1>({
      key: `character:${id}`,
      schema: CharacterNew,
      fetch: async () => (await fetch(`/api/demo/characters/${id}`)).json(),
      staleWhileRevalidate: false,
    });

    this.aheadDisposers.push(
      query.subscribe((state) => {
        // Latched: the refusal is a moment, and the recovery that follows it overwrites the state
        // that reported it. A panel that only rendered the current state would show nothing.
        if (state.unreadable === 'ahead') this.aheadOf.set(true);
        this.appThree.set(state);
      }),
      () => query.dispose(),
    );
  }
}

function emptyState<T>(): QueryState<T> {
  return {
    data: undefined,
    status: 'idle',
    refreshing: false,
    fromCache: false,
    migratedFrom: null,
    downgradedFrom: null,
    derivedPaths: [],
    lossyPaths: [],
    unreadable: null,
    pending: false,
    conflict: null,
  };
}
