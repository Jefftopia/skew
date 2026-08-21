import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

/**
 * The guided tour.
 *
 * The demo shows six failures across two builds, an API, a drawer, and a
 * devtools feed — which is a lot of surface for someone who arrived from a
 * README. The tour is the missing narration: it dims the page, puts a ring
 * around the one thing being talked about, and says why that thing is there.
 *
 * Three properties matter more than the content:
 *
 * - **Startable at any time.** Not a first-run-only modal. The header button
 *   is always there, because the moment someone actually wants the tour is
 *   usually *after* they have clicked around and got confused.
 * - **Cancelable at any time.** Escape, the × , or "Skip tour". A tutorial
 *   that traps you is worse than no tutorial.
 * - **Remembers the preference.** Auto-start fires once, ever. Finishing it
 *   or skipping it both count as "I have seen this" and it never opens by
 *   itself again — but it is never *unavailable*.
 */

export interface TourStep {
  readonly id: string;
  /**
   * `tourAnchor` id of the element to spotlight. Omit for a centered card —
   * used for the opening and closing steps, which are about the demo as a
   * whole rather than any one control.
   */
  readonly anchor?: string;
  /** Route to visit before this step. The tour navigates; the user doesn't. */
  readonly route?: string;
  /**
   * CSS selector, used only when the element belongs to the *remote* build.
   *
   * Host-owned targets use `anchor` and the directive, which fails loudly at
   * build time when a name is wrong. The remote is a separate deployment:
   * the host cannot import its components, and making the remote register
   * anchors with the host's tour service would couple the two builds — the
   * exact thing this demo argues against. So the two agree on a tiny string
   * contract instead (`data-tour="..."` in the remote's template), which is
   * the same bargain as the `{ v, payload }` envelope everywhere else here.
   * If the remote drops the attribute, the step degrades to its waiting
   * state rather than spotlighting the wrong thing.
   */
  readonly selector?: string;
  readonly title: string;
  readonly body: string;
  /** An optional "try it yourself" line, rendered as a call to action. */
  readonly hint?: string;
  readonly placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
}

/** One tour: a named arc of steps, scoped to the tab it explains. */
export interface TourDefinition {
  readonly id: string;
  /** Shown on the header button. */
  readonly label: string;
  /** Route this tour belongs to, so the header can offer the relevant one. */
  readonly route: string;
  readonly steps: readonly TourStep[];
}

const BASICS_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Two builds, one page',
    body:
      'This page is running two separately deployed Angular applications at once — a host and a remote, joined only at runtime. Everything you are about to see is a real production bundle; none of the failures are faked. The tour takes about a minute.',
    hint: 'Arrow keys move between steps. Escape leaves at any point.',
  },
  {
    id: 'identity',
    anchor: 'build-identity',
    placement: 'bottom',
    title: 'This build has a name',
    body:
      'Stamped at build time by `skew-stamp`, along with a timestamp. That timestamp is what makes "the origin is older than me" knowable later — the difference between a safe reload and an infinite reload loop.',
  },
  {
    id: 'tabs',
    anchor: 'tabs',
    placement: 'bottom',
    title: 'Two halves of the same idea',
    body:
      'Basics is the storage and federation boundary: one record crossing between two builds. Portfolio is the API boundary — a live mock backend serving two contract versions at once. The tour visits both.',
  },
  {
    id: 'protections',
    anchor: 'protections',
    placement: 'bottom',
    title: 'The before/after switch',
    body:
      'Turning protections off does not put the library into a "pretend to fail" mode — it makes it inert, so the plain code you would have written instead runs in its place and fails on its own merits.',
    hint: 'Worth re-running any scenario with this off. That comparison is the whole argument.',
  },
  {
    id: 'inspector',
    route: '/basics',
    anchor: 'boundary-inspector',
    placement: 'bottom',
    title: 'What crossed, and what it cost',
    body:
      'This diagram redraws after every step below. The field table is the part to watch: "migrated" means the value came from real data, "derived" means the migration guessed it, and "lost" means the target version had nowhere to put it.',
  },
  {
    id: 'walkthrough',
    route: '/basics',
    anchor: 'walkthrough',
    placement: 'right',
    title: 'One record, five steps',
    body:
      'The host writes a v1 draft; the remote reads it as v2 and migrates it forward; the remote writes v2 back; the host refuses it as `ahead`; then the remote shares its migration chain and that same refusal becomes an honest, lossy projection.',
    hint: 'Press "Run all five" and watch the diagram above change after each one.',
  },
  {
    id: 'remote',
    route: '/basics',
    anchor: 'remote-pane',
    placement: 'left',
    title: 'That panel is a different application',
    body:
      'Built separately, deployed separately, fetched over the network at runtime, and rendered here. It shares no code with this page except the `@braidlabs/skew` runtime itself — the two builds agree on a storage envelope, nothing more.',
  },
  {
    id: 'store',
    route: '/basics',
    anchor: 'store-panel',
    placement: 'top',
    title: 'The entire channel between them',
    body:
      'One key in one browser store. Neither build calls the other. The bytes here carry the version that wrote them, which is what lets a reader from a different deployment know what it is holding before it parses a single field.',
  },
  {
    id: 'devtools',
    anchor: 'devtools',
    placement: 'top',
    title: 'Live schema activity',
    body:
      'Every read and write on the page, from both builds, because they share one core instance. Migrations show as ↑ with their derived paths, contract- or registry-cured downgrades as ↓ with what they dropped, and refusals as the reason your application code actually received.',
    hint: 'Open it and leave it open for the rest of the tour.',
  },
  {
    id: 'done',
    title: 'That covers the Basics tab',
    body:
      'The other half of the demo is the Portfolio tab: a live API serving two contract versions at once, an order queue that survives going offline, and a fund record where you can see exactly which numbers the migration guessed.',
    hint: 'Switch to Portfolio and press "Tour this tab" for that walkthrough.',
  },
];

/**
 * The Portfolio arc. Everything here is a boundary the Basics tab cannot
 * show: a real HTTP contract, a queue that outlives the page, and a
 * reconciliation against an authoritative record.
 *
 * Several steps target the *remote's* DOM — the fund detail is a separately
 * deployed application rendered into this page — so they select on the
 * `data-tour` attributes the remote's template carries rather than on
 * anchors registered here. See `TourStep.selector`.
 */
const PORTFOLIO_STEPS: readonly TourStep[] = [
  {
    id: 'p-welcome',
    route: '/portfolio',
    title: 'The API boundary',
    body:
      'This tab talks to a mock NestJS backend over HTTP, a WebSocket price feed, and an SSE breach stream. The API serves v1 and v2 of the same fund contract at once — what a real service does for as long as its clients take to migrate.',
    hint: 'Needs the API running: npm run api.',
  },
  {
    id: 'p-funds',
    route: '/portfolio',
    anchor: 'fund-list',
    placement: 'right',
    title: 'This build is pinned to v1',
    body:
      'The list reads GET /api/v1/funds through a versioned schema rather than casting the response. The cast would compile either way; only the read tells you when the server sent something else.',
  },
  {
    id: 'p-ticker',
    route: '/portfolio',
    anchor: 'ticker-bar',
    placement: 'bottom',
    title: 'A live feed, versioned like everything else',
    body:
      'Prices arrive over a WebSocket about once a second and are read through TickSchemaV1 — a stream is just another boundary. It is owned by the route rather than the page below it, which is why it keeps running while you open and close funds.',
  },
  {
    id: 'p-breach',
    route: '/portfolio',
    anchor: 'breach-bar',
    placement: 'bottom',
    title: 'Events fire only when you ask',
    body:
      'The liquidity breach stream has no timer. An event you did not trigger is noise wearing the costume of a feature — and this demo is about cause and effect across a boundary, so the cause is a button.',
    hint: 'Press it now if you like; every fund in the book holds the instrument it targets.',
  },
  {
    id: 'p-contract',
    route: '/portfolio',
    anchor: 'contract-card',
    placement: 'top',
    title: 'Data from the future, cured',
    body:
      'This reads a v2 response through a v1 schema — refused as `ahead`, because the fields v2 added were never sent. Then it reads the same bytes through the contract the API publishes at its well-known URL, and gets a labeled, lossy v1 projection. No client redeploy.',
    hint: 'Press "Fetch v2 & read as v1" — the diff underneath names every dropped path.',
  },
  {
    id: 'p-open-fund',
    route: '/portfolio',
    anchor: 'fund-list',
    placement: 'right',
    title: 'Now open one',
    body:
      'A fund detail is a real navigation to a real URL, and the component it loads comes from the other deployment. Redeploying the remote while this page is open is the scenario chunk recovery exists for.',
    hint: 'Click any "Detail →" button to continue. The panel opens beside the list, not over it.',
  },
  {
    id: 'p-recon',
    selector: '[data-tour="recon"]',
    placement: 'left',
    title: 'The guess, beside the truth',
    body:
      'Two records for the same fund: the one handed over from this build (v1, migrated forward to v2) and the authoritative one the server returned. The migration was not wrong to guess — it gave the best answer v1 data allows — but only this comparison makes the guessing visible.',
  },
  {
    id: 'p-diff',
    selector: '[data-tour="recon-diff"]',
    placement: 'left',
    title: 'The whole record, field by field',
    body:
      'The table above is a hand-picked shortlist; this is every field. Lines marked "guessed" are the migration\'s invention — you can see HQLA guessed at 0 against a real 62.5, and an asset class of "unknown" against "Equity". Those are the numbers nobody should act on without confirming.',
    hint: 'Open "Compare the full records" if it is closed.',
  },
  {
    id: 'p-order',
    selector: '[data-tour="order-form"]',
    placement: 'left',
    title: 'The client → API boundary',
    body:
      'Submitting an order goes through the @braidlabs/angular-data outbox. The API genuinely refuses a v1-shaped order with 409 version-skew, and the runner catches that, migrates the queued payload, and retries — rather than the queue resending the same stale envelope forever.',
    hint: 'The "queue as v1" button provokes the 409 on purpose.',
  },
  {
    id: 'p-offline',
    selector: '[data-tour="offline-bar"]',
    placement: 'top',
    title: 'And when the network is gone',
    body:
      'Flip "Simulate offline" and submit: the POST fails exactly as a dead network does, and the order waits in a durable queue. Reload the page — it is still there. A queued mutation has to survive a reload, which is why the outbox persists rather than holding a pending promise.',
    hint: 'Turn the toggle back off and the queue drains on its own.',
  },
  {
    id: 'p-done',
    title: 'That is the Portfolio tab',
    body:
      'Everything here ran against a real API with two live contract versions. The one scenario left is the one that cannot be faked: redeploy the remote from a second terminal while this tab is open, then open a fund you have not opened yet.',
    hint: 'npm run demo:prod:redeploy-remote — see apps/README.md.',
  },
];

/**
 * Named rather than indexed out of the array below, so the "no tour matched"
 * fallbacks are a real reference instead of `TOURS[0]!` — this workspace runs
 * `noUncheckedIndexedAccess`, and an assertion there would be the one place
 * the tour lies about what it knows.
 */
const BASICS_TOUR: TourDefinition = {
  id: 'basics',
  label: 'Tour this tab',
  route: '/basics',
  steps: BASICS_STEPS,
};

const PORTFOLIO_TOUR: TourDefinition = {
  id: 'portfolio',
  label: 'Tour this tab',
  route: '/portfolio',
  steps: PORTFOLIO_STEPS,
};

export const TOURS: readonly TourDefinition[] = [BASICS_TOUR, PORTFOLIO_TOUR];

const PREF_KEY = 'skew-demo:tour:v1';

interface TourPrefs {
  /** False once the user has finished or skipped — never auto-opens again. */
  readonly autoStart: boolean;
}

@Injectable({ providedIn: 'root' })
export class Tour {
  private readonly router = inject(Router);

  readonly tours = TOURS;

  private readonly index = signal(0);
  private readonly tourId = signal(BASICS_TOUR.id);
  private readonly anchors = signal<ReadonlyMap<string, HTMLElement>>(new Map());

  /**
   * Re-read on every navigation so the header offers the tour for the tab
   * you are looking at. Two shorter arcs beat one long one: somebody who
   * opens Portfolio wants the Portfolio narration, not to sit through the
   * Basics tab first.
   */
  private readonly url = toSignal(
    inject(Router).events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: inject(Router).url },
  );

  readonly active = signal(false);
  readonly currentTour = computed(
    () => this.tours.find((t) => t.id === this.tourId()) ?? BASICS_TOUR,
  );
  readonly steps = computed(() => this.currentTour().steps);

  /** The tour matching the route on screen, for the header button. */
  readonly tourForCurrentRoute = computed(() => {
    const path = this.url().split('?')[0] ?? '';
    return this.tours.find((t) => path.startsWith(t.route)) ?? BASICS_TOUR;
  });

  readonly current = computed(() =>
    this.active() ? (this.steps()[this.index()] ?? null) : null,
  );
  readonly stepNumber = computed(() => this.index() + 1);
  readonly stepCount = computed(() => this.steps().length);
  readonly isFirst = computed(() => this.index() === 0);
  readonly isLast = computed(() => this.index() === this.steps().length - 1);

  /**
   * The element for the current step, or null when the step is centered or
   * its anchor has not rendered yet (a lazy route mid-navigation, the remote
   * still being fetched). The overlay treats "not yet" as a state to wait in
   * rather than an error — the anchor map is a signal, so the spotlight snaps
   * into place the moment the element appears.
   */
  /**
   * Resolves the current step's target, or null if it has not appeared yet.
   *
   * A plain method, deliberately, and this is worth stating because the
   * obvious `computed()` is wrong: half of these targets are found with
   * `document.querySelector` (the remote's DOM — see `TourStep.selector`),
   * and a DOM query is not a signal. A computed would cache the `null` it
   * got before the remote rendered and never look again, leaving the tour
   * waiting forever beside an element that is right there. The overlay calls
   * this from its per-frame tracking loop instead, which is already how it
   * follows an element through scrolling and layout changes.
   */
  resolveAnchor(): HTMLElement | null {
    const step = this.current();
    if (!step) return null;
    if (step.anchor) return this.anchors().get(step.anchor) ?? null;
    if (step.selector) return document.querySelector<HTMLElement>(step.selector);
    return null;
  }

  /** True when the current step expects a target at all. */
  readonly stepWantsAnchor = computed(() => {
    const step = this.current();
    return !!step && !!(step.anchor ?? step.selector);
  });

  /** Whether the tour has ever been seen — drives the auto-start decision. */
  readonly autoStartAllowed = signal(this.readPrefs().autoStart);

  registerAnchor(id: string, el: HTMLElement): void {
    this.anchors.update((prev) => new Map(prev).set(id, el));
  }

  unregisterAnchor(id: string, el: HTMLElement): void {
    this.anchors.update((prev) => {
      // Guard against a re-registration having already replaced this entry:
      // routing can create the next instance before destroying the last.
      if (prev.get(id) !== el) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  /**
   * Opens a tour at its first step. Defaults to the one for the current
   * route. Safe to call while another is already open.
   */
  start(id?: string): void {
    this.tourId.set(id ?? this.tourForCurrentRoute().id);
    this.index.set(0);
    this.active.set(true);
    this.applyRoute();
  }

  /**
   * Opens the tour only if it has never been seen. Called once at startup —
   * a first-run affordance, not a recurring interruption.
   */
  startIfUnseen(): void {
    if (this.autoStartAllowed()) this.start(BASICS_TOUR.id);
  }

  next(): void {
    if (this.isLast()) {
      this.stop();
      return;
    }
    this.index.update((n) => n + 1);
    this.applyRoute();
  }

  back(): void {
    if (this.isFirst()) return;
    this.index.update((n) => n - 1);
    this.applyRoute();
  }

  goTo(i: number): void {
    if (i < 0 || i >= this.steps().length) return;
    this.index.set(i);
    this.applyRoute();
  }

  /**
   * Leaves the tour. Either way — finished or skipped — the preference is
   * recorded: the user has now seen it exists, so it should never open by
   * itself again. It stays reachable from the header forever.
   */
  stop(): void {
    this.active.set(false);
    this.rememberSeen();
  }

  /** Restores the first-run behaviour, for demoing the demo. */
  resetPreference(): void {
    this.writePrefs({ autoStart: true });
    this.autoStartAllowed.set(true);
  }

  private rememberSeen(): void {
    if (!this.autoStartAllowed()) return;
    this.writePrefs({ autoStart: false });
    this.autoStartAllowed.set(false);
  }

  /**
   * Puts the page on the current step's route, one navigation at a time.
   *
   * Serialized, and — the part that matters — each queued turn reads the
   * step *at the moment it runs* rather than the one that scheduled it. Hold
   * down the arrow key and a dozen of these queue up; every intermediate one
   * then sees the latest step and no-ops, so the page ends on the route the
   * user actually stopped at. Firing them concurrently instead lets a lazy
   * route that resolves slowly land after a later navigation and win, which
   * strands the tour pointing at a page it did not open.
   */
  private applyRoute(): void {
    this.navigations = this.navigations
      .then(async () => {
        const step = this.current();
        if (!step?.route) return;
        if (this.router.url.split('?')[0] === step.route) return;
        await this.router.navigateByUrl(step.route);
      })
      .catch(() => {
        // A cancelled or failed navigation is not the tour's problem to
        // report — the step simply shows its "waiting" state.
      });
  }

  private navigations: Promise<void> = Promise.resolve();

  // Storage is wrapped because Safari private mode throws on access rather
  // than returning null — and a tutorial that crashes the app it is
  // explaining would be a poor advertisement for a library about resilience.
  private readPrefs(): TourPrefs {
    try {
      const raw = globalThis.localStorage?.getItem(PREF_KEY);
      if (!raw) return { autoStart: true };
      const parsed = JSON.parse(raw) as Partial<TourPrefs>;
      return { autoStart: parsed.autoStart !== false };
    } catch {
      return { autoStart: true };
    }
  }

  private writePrefs(prefs: TourPrefs): void {
    try {
      globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(prefs));
    } catch {
      // Preference is a nicety; losing it costs one extra auto-open.
    }
  }
}
