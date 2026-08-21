import { Component, inject, signal } from '@angular/core';
import { DATA_OPTIONS, OutboxService } from '@braid/angular-data';
import { createOutbox, memoryRecordDriver, type Outbox, type QueuedEntry } from '@braid/data';
import { DemoPanel } from './panel';

/**
 * Act three — offline and durability. Everything here works today, on the shipped data layer.
 *
 * This is the most persuasive material available: queued work surviving a reload, and two tabs not
 * double-sending, are things most stacks cannot show at all.
 */
@Component({
  selector: 'demo-durability',
  standalone: true,
  imports: [DemoPanel],
  template: `
    <h2>Offline and durability</h2>

    <demo-panel
      [n]="8"
      claim="Go offline and submit. Your work is queued, not lost."
      proves="The offline outbox — a mutation that cannot be sent is kept, not discarded"
    >
      <div class="row">
        <button type="button" (click)="toggleOffline()">
          {{ offline() ? 'Go back online' : 'Go offline' }}
        </button>
        <span class="state" [class.off]="offline()">{{ offline() ? 'offline (simulated)' : 'online' }}</span>
      </div>

      <div class="row">
        <input [value]="draft()" (input)="draft.set(asValue($event))" aria-label="New name" />
        <button type="button" (click)="submit()">Rename Luke</button>
      </div>

      <p class="count">
        Queued on this page: <strong>{{ outbox.pendingCount() }}</strong>
        <span class="sub">({{ outbox.entries().length }} owned by the host)</span>
      </p>

      @if (outbox.entries().length > 0) {
        <ul class="queue">
          @for (entry of outbox.entries(); track entry.id) {
            <li>
              <code>{{ entry.mutationId }}</code>
              <span class="owner">{{ entry.owner }}</span>
              @if (entry.attempts > 0) {
                <span class="attempts">{{ entry.attempts }} attempt(s)</span>
              }
            </li>
          }
        </ul>
      }
      <p class="hint">
        "Offline" is simulated on the mock API — a page cannot force the browser offline. Failed
        requests will appear in the console while it is on; that is the point, not a fault.
      </p>
    </demo-panel>

    <demo-panel
      [n]="9"
      claim="Reload the page. One of these queues survives. The other is gone."
      proves="What persistOutbox: true actually buys — the same work, kept or lost"
    >
      <p class="hint">
        Queue the same change into two outboxes: one configured with
        <code>persistOutbox: true</code>, one left in memory. Then reload. Everything else about
        them is identical.
      </p>

      <div class="row">
        <button type="button" (click)="queueBoth()">Queue a change into both</button>
        <button type="button" (click)="reload()">Reload this page</button>
      </div>

      <div class="apps">
        <div class="app" [class.gone]="persisted().length === 0">
          <span class="tag ok">persistOutbox: true</span>
          <strong>{{ persisted().length }} queued</strong>
          @for (entry of persisted(); track entry.id) {
            <span class="mono">{{ entry.mutationId }}</span>
          }
        </div>
        <div class="app" [class.gone]="inMemory().length === 0">
          <span class="tag off">in memory</span>
          <strong>{{ inMemory().length }} queued</strong>
          @for (entry of inMemory(); track entry.id) {
            <span class="mono">{{ entry.mutationId }}</span>
          }
        </div>
      </div>

      <p class="hint">
        Before reloading, both show the same count. After, the in-memory queue is empty — that work
        is unrecoverable, and the user was told it saved. The persisted one is read back off disk,
        still owned by whoever queued it and still in order.
      </p>
    </demo-panel>

    <demo-panel
      [n]="10"
      claim="Open a second tab. Only one of them sends."
      proves="Flush leadership — Web Locks elect one flusher across every tab and realm"
    >
      <div class="row">
        <button type="button" (click)="openSecondTab()">Open a second tab</button>
        <button type="button" (click)="flush()" [disabled]="offline()">Flush now</button>
      </div>
      <p class="count">
        Sent from this tab: <strong>{{ sent() }}</strong>
        @if (stoodDown()) {
          <span class="sub">— stood down at least once; another tab held the lock</span>
        }
      </p>
      <p class="hint">
        Press "Flush now" in both tabs at once. The mutation is replayed once, not twice: without
        this every open tab drains the same queue on reconnect, against a server that is by
        definition just coming back.
      </p>
    </demo-panel>

    <demo-panel
      [n]="11"
      claim="The other app has unsent work too, and this app did not touch it."
      proves="Owned entries — an app whose owner is not mounted keeps its work, rather than losing it"
    >
      <div class="row">
        <button type="button" (click)="queueAsOtherApp()">Queue work as the billing app</button>
      </div>
      <p class="count">
        Waiting for another app: <strong>{{ outbox.foreignEntries().length }}</strong>
      </p>
      @if (outbox.foreignEntries().length > 0) {
        <ul class="queue">
          @for (entry of outbox.foreignEntries(); track entry.id) {
            <li>
              <code>{{ entry.mutationId }}</code>
              <span class="owner foreign">{{ entry.owner }}</span>
            </li>
          }
        </ul>
      }
      <p class="hint">
        Flush above and watch this number stay put. Previously a second app would rehydrate this
        entry, find no runner for it, and drop someone's unsent work — silently.
      </p>
    </demo-panel>
  `,
  styles: `
    :host { display: block; }
    h2 { font-size: 1.05rem; margin: 1.4rem 0 0.6rem; }
    .row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    button { font: inherit; padding: 0.3rem 0.7rem; border: 1px solid #cbd5e1; border-radius: 5px; background: #f8fafc; cursor: pointer; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    input { flex: 1; min-width: 10rem; padding: 0.35rem 0.5rem; border: 1px solid #cbd5e1; border-radius: 5px; font: inherit; }
    .state { font-size: 0.82rem; color: #16a34a; }
    .state.off { color: #b91c1c; font-weight: 600; }
    .count { margin: 0; font-size: 0.88rem; }
    .sub { color: #64748b; font-size: 0.8rem; font-weight: 400; }
    .queue { margin: 0; padding-left: 1rem; font-size: 0.82rem; display: flex; flex-direction: column; gap: 0.2rem; }
    .queue li { display: flex; gap: 0.5rem; align-items: center; }
    .owner { font-size: 0.72rem; border: 1px solid #cbd5e1; border-radius: 999px; padding: 0 0.45rem; color: #475569; }
    .owner.foreign { border-color: #f59e0b; color: #b45309; }
    .apps { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.5rem; }
    .app { border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.5rem 0.6rem; display: flex; flex-direction: column; gap: 0.25rem; }
    .app.gone { border-style: dashed; opacity: 0.75; }
    .tag { font-size: 0.7rem; border-radius: 999px; padding: 0.1rem 0.45rem; align-self: flex-start; color: #fff; font-family: ui-monospace, monospace; }
    .tag.ok { background: #16a34a; }
    .tag.off { background: #94a3b8; }
    .mono { font-family: ui-monospace, monospace; font-size: 0.75rem; color: #64748b; }
    .attempts { font-size: 0.72rem; color: #b45309; }
    .hint { margin: 0; font-size: 0.82rem; color: #64748b; line-height: 1.45; }
  `,
})
export class DemoDurability {
  readonly outbox = inject(OutboxService);
  private readonly options = inject(DATA_OPTIONS);

  readonly offline = signal(false);
  readonly persisted = signal<QueuedEntry[]>([]);
  readonly inMemory = signal<QueuedEntry[]>([]);
  readonly draft = signal('Luke Starkiller');
  readonly sent = signal(0);
  readonly stoodDown = signal(false);

  /**
   * Two queues that differ only in where they are stored: the app's IndexedDB driver, and a fresh
   * in-memory one. A separate collection keeps this comparison out of the queue panels 8, 10, and
   * 11 are reading.
   */
  private readonly persistedQueue: Outbox = createOutbox({
    driver: this.options.driver,
    owner: 'host',
    collection: 'outbox',
    partition: 'compare',
  });
  private readonly memoryQueue: Outbox = createOutbox({
    driver: memoryRecordDriver(),
    owner: 'host',
    collection: 'outbox',
    partition: 'compare',
  });

  constructor() {
    void this.refreshComparison();

    // Floating on purpose — the panel renders before the queue is read, and a rejection here must
    // not take the page down with it.
    this.outbox.load().catch(() => undefined);

    // The host's half of the rename. Registered at construction because a queued entry replayed
    // after a reload needs its runner to already exist — there is no closure left to call.
    this.outbox.register('demo.rename', async (input) => {
      const { id, name } = input as { id: string; name: string };
      const response = await fetch(`/api/demo/characters/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.sent.update((n) => n + 1);
      return response.json();
    });
  }

  /**
   * The same change, queued into two outboxes that differ in exactly one way.
   *
   * The in-memory one is a `memoryRecordDriver` — which is precisely what `persistOutbox: false`
   * gives you. Everything else (owner, ordering, the entry itself) is identical, so a reload
   * isolates the one variable.
   */
  async queueBoth(): Promise<void> {
    await Promise.all([
      this.persistedQueue.enqueue({ mutationId: 'demo.rename', input: { id: '1', name: this.draft() } }),
      this.memoryQueue.enqueue({ mutationId: 'demo.rename', input: { id: '1', name: this.draft() } }),
    ]);
    await this.refreshComparison();
  }

  /**
   * Clears both queues and re-reads them.
   *
   * The page's reset cannot do this on its own: it clears the *persisted* partition, which leaves
   * the in-memory queue holding entries no driver of the page's knows about, and leaves these
   * signals showing counts that are no longer true. A panel whose numbers can be stale proves
   * nothing, so the panel owns its own reset.
   */
  async resetComparison(): Promise<void> {
    await Promise.all([
      ...(await this.persistedQueue.mine()).map((entry) => this.persistedQueue.remove(entry.id)),
      ...(await this.memoryQueue.mine()).map((entry) => this.memoryQueue.remove(entry.id)),
    ]);
    await this.refreshComparison();
  }

  private async refreshComparison(): Promise<void> {
    const [persisted, inMemory] = await Promise.all([this.persistedQueue.mine(), this.memoryQueue.mine()]);
    this.persisted.set(persisted);
    this.inMemory.set(inMemory);
  }

  asValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  async toggleOffline(): Promise<void> {
    const next = !this.offline();

    // Flipped only once the server agrees. Setting it first would let the Flush button enable
    // while the mock was still refusing writes — the UI claiming a state the server has not
    // accepted, which is its own small lie and produced a confusing failure here.
    await fetch('/api/demo/behavior', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offline: next }),
    });
    this.offline.set(next);
  }

  async submit(): Promise<void> {
    await this.outbox.enqueue({
      mutationId: 'demo.rename',
      input: { id: '1', name: this.draft() },
      schemaVersion: 1,
    });
    if (!this.offline()) await this.flush();
  }

  async flush(): Promise<void> {
    const result = await this.outbox.flush();
    // Reported by the service rather than inferred from `sent === 0`, which is also what a flush
    // that ran and failed looks like — the panel would otherwise blame another tab for a dead
    // server.
    if (result.skipped) this.stoodDown.set(true);
  }

  /**
   * Queues an entry under a different owner, standing in for the billing app having done it.
   *
   * The *same* driver the service uses — the claim is about a shared store, so a second driver
   * would demonstrate the opposite.
   */
  async queueAsOtherApp(): Promise<void> {
    await createOutbox({ driver: this.options.driver, owner: 'billing', collection: 'outbox' }).enqueue({
      mutationId: 'billing.saveInvoice',
      input: { total: 42 },
    });
    await this.outbox.load();
    await this.outbox.flush();
  }

  reload(): void {
    location.reload();
  }

  openSecondTab(): void {
    window.open(location.href, '_blank');
  }
}
