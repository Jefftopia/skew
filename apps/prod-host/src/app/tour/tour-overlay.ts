import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Tour } from './tour';

interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

type Placement = 'top' | 'bottom' | 'left' | 'right';

/** Breathing room between the ring and the element it surrounds. */
const PAD = 8;
/** Gap between the ring and the callout. */
const GAP = 16;
/** Keep the callout this far from the viewport edge. */
const EDGE = 14;
const WIDTH = 352;

@Component({
  selector: 'host-tour-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tour-overlay.css',
  host: {
    '(document:keydown)': 'onKey($event)',
  },
  template: `
    @if (tour.active() && tour.current(); as step) {
      <!--
        The scrim is four panels, not one element with a hole punched in it.
        A clip-path would have been fewer lines, but the gap between these
        panels is a genuine gap: pointer events reach the spotlit element
        without any hit-testing subtlety, so the highlighted control stays
        usable while everything around it is both dimmed and inert.
      -->
      @if (ring(); as r) {
        <div class="scrim" [style.height.px]="r.top" style="top:0;left:0;right:0"></div>
        <div
          class="scrim"
          [style.top.px]="r.top + r.height"
          style="left:0;right:0;bottom:0"
        ></div>
        <div
          class="scrim"
          [style.top.px]="r.top"
          [style.height.px]="r.height"
          [style.width.px]="r.left"
          style="left:0"
        ></div>
        <div
          class="scrim"
          [style.top.px]="r.top"
          [style.height.px]="r.height"
          [style.left.px]="r.left + r.width"
          style="right:0"
        ></div>

        <div
          class="ring"
          [style.top.px]="r.top"
          [style.left.px]="r.left"
          [style.width.px]="r.width"
          [style.height.px]="r.height"
        ></div>
      } @else {
        <!--
          No target yet. When the step is *waiting* for one — usually because
          it is asking the user to open something — the scrim must not block
          the click that would produce it. A tutorial that says "click Detail"
          and then swallows the click is worse than no tutorial. Steps with no
          anchor at all (the opening and closing cards) stay modal.
        -->
        <div
          class="scrim"
          style="inset:0"
          [class.pass-through]="awaiting()"
        ></div>
      }

      <div
        #callout
        class="callout"
        [class]="'callout place-' + placement()"
        [style.top.px]="position().top"
        [style.left.px]="position().left"
        [style.width.px]="width()"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'Tour step ' + tour.stepNumber() + ': ' + step.title"
      >
        @if (ring()) {
          <span
            class="caret"
            [style.left.px]="caret().x"
            [style.top.px]="caret().y"
          ></span>
        }

        <div class="head">
          <span class="count"
            >{{ tour.stepNumber() }} <i>/</i> {{ tour.stepCount() }}</span
          >
          <button
            class="x"
            type="button"
            (click)="tour.stop()"
            aria-label="Close tour"
          >
            ×
          </button>
        </div>

        <h4>{{ step.title }}</h4>
        <p>{{ step.body }}</p>

        @if (step.hint) {
          <p class="hint">{{ step.hint }}</p>
        }

        @if (awaiting()) {
          <p class="pending">
            Waiting for that part of the page — the rest of the page is
            clickable while this step waits.
          </p>
        }

        <div class="dots" role="tablist" aria-label="Tour steps">
          @for (s of tour.steps(); track s.id; let i = $index) {
            <button
              type="button"
              class="dot"
              [class.on]="i === tour.stepNumber() - 1"
              [attr.aria-label]="'Go to step ' + (i + 1) + ': ' + s.title"
              (click)="tour.goTo(i)"
            ></button>
          }
        </div>

        <div class="actions">
          <button class="skip" type="button" (click)="tour.stop()">
            Skip tour
          </button>
          <div class="spacer"></div>
          @if (!tour.isFirst()) {
            <button class="ghost" type="button" (click)="tour.back()">
              Back
            </button>
          }
          <button class="go" type="button" (click)="tour.next()">
            {{ tour.isLast() ? 'Done' : 'Next' }}
          </button>
        </div>

        <p class="foot">Esc to leave · ← → to move</p>
      </div>
    }
  `,
})
export class TourOverlay {
  protected readonly tour = inject(Tour);

  private readonly calloutRef =
    viewChild<ElementRef<HTMLElement>>('callout');

  /** The live target, re-resolved every frame by the tracking loop below. */
  private readonly anchorEl = signal<HTMLElement | null>(null);

  /** True when a step expects a target that has not rendered yet. */
  protected readonly awaiting = computed(
    () => this.tour.stepWantsAnchor() && !this.anchorEl(),
  );

  /** The spotlit element's box, padded. Null for centered steps. */
  private readonly rect = signal<Box | null>(null);
  private readonly viewport = signal({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 720 : window.innerHeight,
  });
  private readonly calloutSize = signal({ w: WIDTH, h: 220 });

  /** Narrow viewports get a narrower card rather than one hanging off-screen. */
  protected readonly width = computed(() =>
    Math.max(220, Math.min(WIDTH, this.viewport().w - EDGE * 2)),
  );

  protected readonly ring = computed<Box | null>(() => this.rect());

  protected readonly placement = computed<Placement>(() => {
    const r = this.rect();
    const vp = this.viewport();
    const size = this.calloutSize();
    if (!r) return 'bottom';

    const fits = {
      bottom: vp.h - (r.top + r.height) >= size.h + GAP + EDGE,
      top: r.top >= size.h + GAP + EDGE,
      left: r.left >= size.w + GAP + EDGE,
      right: vp.w - (r.left + r.width) >= size.w + GAP + EDGE,
    };

    const wanted = this.tour.current()?.placement ?? 'auto';
    if (wanted !== 'auto' && fits[wanted]) return wanted;

    // Preference order when the requested side doesn't fit: keep the callout
    // below the target where possible, because a card that jumps above the
    // thing it describes reads as a different card.
    for (const side of ['bottom', 'top', 'right', 'left'] as const) {
      if (fits[side]) return side;
    }
    return 'bottom';
  });

  protected readonly position = computed(() => {
    const r = this.rect();
    const vp = this.viewport();
    const size = this.calloutSize();

    if (!r) {
      return {
        top: Math.max(EDGE, vp.h / 2 - size.h / 2),
        left: Math.max(EDGE, vp.w / 2 - size.w / 2),
      };
    }

    const place = this.placement();
    const clamp = (v: number, min: number, max: number) =>
      Math.min(Math.max(v, min), Math.max(min, max));

    if (place === 'bottom' || place === 'top') {
      const left = clamp(
        r.left + r.width / 2 - size.w / 2,
        EDGE,
        vp.w - size.w - EDGE,
      );
      const top =
        place === 'bottom' ? r.top + r.height + GAP : r.top - GAP - size.h;
      return { top: clamp(top, EDGE, vp.h - size.h - EDGE), left };
    }

    const top = clamp(
      r.top + r.height / 2 - size.h / 2,
      EDGE,
      vp.h - size.h - EDGE,
    );
    const left =
      place === 'right' ? r.left + r.width + GAP : r.left - GAP - size.w;
    return { top, left: clamp(left, EDGE, vp.w - size.w - EDGE) };
  });

  /**
   * Where the caret sits on the callout's edge — computed rather than centered,
   * because the callout gets clamped at viewport edges and a caret that stays
   * in the middle would then point at nothing in particular.
   */
  protected readonly caret = computed(() => {
    const r = this.rect();
    const pos = this.position();
    const size = this.calloutSize();
    if (!r) return { x: -99, y: -99 };

    const place = this.placement();
    const clamp = (v: number, min: number, max: number) =>
      Math.min(Math.max(v, min), Math.max(min, max));

    if (place === 'bottom' || place === 'top') {
      return {
        x: clamp(r.left + r.width / 2 - pos.left, 22, size.w - 22),
        y: place === 'bottom' ? -7 : size.h - 7,
      };
    }
    return {
      x: place === 'right' ? -7 : size.w - 7,
      y: clamp(r.top + r.height / 2 - pos.top, 22, size.h - 22),
    };
  });

  constructor() {
    // Scroll and resize drive the common case. Listening beats polling here:
    // an rAF loop running for as long as the tour is open keeps the page in
    // permanent repaint, which is a real cost in a zoneless app and shows up
    // as jank on the very scenarios this demo is trying to make legible.
    effect((onCleanup) => {
      if (!this.tour.active()) {
        this.rect.set(null);
        return;
      }
      const remeasure = () => this.measure();
      const opts = { capture: true, passive: true } as const;
      window.addEventListener('scroll', remeasure, opts);
      window.addEventListener('resize', remeasure);
      onCleanup(() => {
        window.removeEventListener('scroll', remeasure, opts);
        window.removeEventListener('resize', remeasure);
      });
    });

    // Per step: measure now, watch the two elements whose size can change
    // without any event firing, and run a short settling burst to cover the
    // layout that arrives on its own schedule — a lazy route rendering, the
    // remote finally being fetched, a smooth scroll easing to a stop. Bounded,
    // so it always ends.
    // Keyed by *step*, not by element. Keying on the element alone looks
    // equivalent and quietly breaks going backwards: step back to something
    // already visited and the element is unchanged, so the scroll is skipped
    // and the ring sits off-screen with nothing to show. Two steps that share
    // an anchor (here: "the fund list" and "now open one") each still get
    // their own scroll.
    let scrolledFor: { step: string; el: HTMLElement } | null = null;
    effect((onCleanup) => {
      const el = this.anchorEl();
      const step = this.tour.current();
      if (!step) {
        scrolledFor = null;
        return;
      }

      if (el && (scrolledFor?.step !== step.id || scrolledFor.el !== el)) {
        scrolledFor = { step: step.id, el };
        this.bringIntoView(el, onCleanup);
      }
      // preventScroll matters: focusing a fixed-position card would otherwise
      // cancel the smooth scroll that was just started for the anchor.
      queueMicrotask(() =>
        this.calloutRef()?.nativeElement.focus({ preventScroll: true }),
      );

      this.measure();

      const observer = new ResizeObserver(() => this.measure());
      if (el) observer.observe(el);
      const callout = untracked(() => this.calloutRef())?.nativeElement;
      if (callout) observer.observe(callout);

      let frame = 0;
      const deadline = performance.now() + 1200;
      const settle = () => {
        this.measure();
        if (performance.now() < deadline) frame = requestAnimationFrame(settle);
      };
      frame = requestAnimationFrame(settle);

      onCleanup(() => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      });
    });
  }

  /**
   * Scrolls a target into view, then makes sure it actually got there.
   *
   * Smooth scrolling is a nicety, and the environment is allowed to decline
   * it: headless browsers drop the animation entirely, and so do some
   * embedded webviews — without setting `prefers-reduced-motion`, so there is
   * no media query to branch on. The animation is optional; the spotlight
   * being on screen is not, and a ring the user cannot see is a broken step.
   * So: ask nicely, then verify and snap.
   */
  private bringIntoView(
    el: HTMLElement,
    onCleanup: (fn: () => void) => void,
  ): void {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });

    const timer = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      const margin = 40;
      const visible =
        r.top < window.innerHeight - margin && r.bottom > margin;
      if (!visible) el.scrollIntoView({ block: 'center' });
    }, 450);

    // Cleared when the step changes, so a late snap can never yank the page
    // back to the element the user has already moved past.
    onCleanup(() => clearTimeout(timer));
  }

  /** Reads the live geometry into signals, writing only on actual change. */
  private measure(): void {
    // Resolved here rather than read from a computed: half of these targets
    // are found with `document.querySelector` (the remote's DOM), and a DOM
    // query is not a signal — a computed would cache the `null` it saw
    // before the remote rendered and never look again.
    const el = this.tour.resolveAnchor();
    if (untracked(() => this.anchorEl()) !== el) this.anchorEl.set(el);

    const next = el ? padded(el.getBoundingClientRect()) : null;
    if (!same(untracked(() => this.rect()), next)) this.rect.set(next);

    const vp = { w: window.innerWidth, h: window.innerHeight };
    const prevVp = untracked(() => this.viewport());
    if (vp.w !== prevVp.w || vp.h !== prevVp.h) this.viewport.set(vp);

    const node = untracked(() => this.calloutRef())?.nativeElement;
    if (node?.offsetHeight) {
      const size = { w: node.offsetWidth, h: node.offsetHeight };
      const prev = untracked(() => this.calloutSize());
      if (size.w !== prev.w || size.h !== prev.h) this.calloutSize.set(size);
    }
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.tour.active()) return;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.tour.stop();
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.tour.next();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.tour.back();
        break;
    }
  }
}

function padded(r: DOMRect): Box {
  return {
    top: Math.max(0, r.top - PAD),
    left: Math.max(0, r.left - PAD),
    width: r.width + PAD * 2,
    height: r.height + PAD * 2,
  };
}

function same(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
