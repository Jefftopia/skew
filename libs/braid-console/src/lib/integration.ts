import type { DiscoveryEntry } from '@braid/gateway';

/**
 * The code a host application needs to embed a registered fragment.
 *
 * **Generated from the manifest, not from a template someone keeps in sync by hand.** Everything
 * that varies between fragments — whether it needs a `src`, whether it takes props, whether it
 * emits events — is already in the discovery entry, and the reason to generate the snippet here
 * rather than document it once is that the differences are exactly what a reader gets wrong.
 * A widget embedded without its `src` renders an empty shell on every page, and that is a
 * question answered by a field the console is already displaying.
 *
 * The snippets deliberately show the *whole* integration, one-time setup included. A snippet that
 * shows only the markup produces a slot that never boots, and the person who copied it has no way
 * to know which half they are missing.
 */

export type IntegrationTarget = 'html' | 'angular' | 'react';

export interface IntegrationSnippet {
  target: IntegrationTarget;
  label: string;
  language: string;
  code: string;
}

export const INTEGRATION_TARGETS: { id: IntegrationTarget; label: string }[] = [
  { id: 'html', label: 'HTML' },
  { id: 'angular', label: 'Angular' },
  { id: 'react', label: 'React' },
];

/** True when the fragment is a widget — no route of its own, so a host must say where to load it. */
function isWidget(entry: DiscoveryEntry): boolean {
  return entry.bound === false;
}

/**
 * The `src` a widget needs, or null.
 *
 * A widget whose manifest declares no `src` is a real configuration gap rather than something to
 * paper over with a plausible-looking default: the gateway would ask the fragment's endpoint for
 * the *host's* path, which means nothing to it. The snippet says so instead of guessing.
 */
function srcOf(entry: DiscoveryEntry): string | null {
  if (!isWidget(entry)) return null;
  return entry.src ?? null;
}

function widgetNote(entry: DiscoveryEntry, comment: (text: string) => string): string[] {
  if (!isWidget(entry)) return [];
  const src = srcOf(entry);
  return src
    ? [comment(`A widget: it has no route of its own, so "src" says where its content lives.`)]
    : [
        comment(`This widget declares no "src" in its manifest, so there is no path to put here.`),
        comment(`Add one to the manifest — without it the endpoint is asked for the host's path.`),
      ];
}

/** Custom-element fragments take props and emit events; that is the whole reason to show them. */
function takesProps(entry: DiscoveryEntry): boolean {
  return entry.adapter === 'custom-element';
}

export function integrationSnippet(entry: DiscoveryEntry, target: IntegrationTarget): IntegrationSnippet {
  switch (target) {
    case 'html':
      return { target, label: 'HTML', language: 'html', code: htmlSnippet(entry) };
    case 'angular':
      return { target, label: 'Angular', language: 'typescript', code: angularSnippet(entry) };
    case 'react':
      return { target, label: 'React', language: 'tsx', code: reactSnippet(entry) };
  }
}

export function allIntegrationSnippets(entry: DiscoveryEntry): IntegrationSnippet[] {
  return INTEGRATION_TARGETS.map(({ id }) => integrationSnippet(entry, id));
}

const html = (text: string) => `<!-- ${text} -->`;
const js = (text: string) => `// ${text}`;

function htmlSnippet(entry: DiscoveryEntry): string {
  const src = srcOf(entry);
  const notes = widgetNote(entry, html);

  const slot = `<fragment-slot name="${entry.id}"${src ? ` src="${src}"` : ''}></fragment-slot>`;

  // A custom-element fragment takes props, and in plain HTML there is no binding syntax to do it
  // with — they are assigned as a DOM *property* so the value crosses the realm boundary as data
  // rather than being stringified into an attribute.
  const props = takesProps(entry)
    ? [
        ``,
        js(`Props are a property, not an attribute — objects must cross as data.`),
        `const slot = document.querySelector('fragment-slot[name="${entry.id}"]');`,
        `slot.props = { };`,
        `slot.addEventListener('braid:event', (event) => console.log(event.detail));`,
      ]
    : [];

  return [
    js(`Once, anywhere in the host's own bundle:`),
    `import { initBraid } from '@braid/core';`,
    `initBraid();`,
    ``,
    ...notes,
    slot,
    ...props,
  ].join('\n');
}

function angularSnippet(entry: DiscoveryEntry): string {
  const src = srcOf(entry);
  const notes = widgetNote(entry, html);

  const attributes = [`name="${entry.id}"`, ...(src ? [`src="${src}"`] : [])];
  if (takesProps(entry)) attributes.push(`[props]="{ }"`, `(fragmentEvent)="onFragmentEvent($event)"`);

  return [
    js(`1. Once, in the application's providers:`),
    `import { provideBraid } from '@braid/angular';`,
    ``,
    `bootstrapApplication(App, { providers: [provideBraid()] });`,
    ``,
    js(`2. In the component that shows it:`),
    `import { BraidFragment } from '@braid/angular';`,
    ``,
    `@Component({`,
    `  imports: [BraidFragment],`,
    `  template: \``,
    ...notes.map((note) => `    ${note}`),
    `    <braid-fragment ${attributes.join(' ')} />`,
    `  \`,`,
    `})`,
    `export class HostComponent {}`,
  ].join('\n');
}

function reactSnippet(entry: DiscoveryEntry): string {
  const src = srcOf(entry);
  const notes = widgetNote(entry, (text) => `{/* ${text} */}`);

  const attributes = [`name="${entry.id}"`, ...(src ? [`src="${src}"`] : [])];
  if (takesProps(entry)) attributes.push(`props={{}}`, `onFragmentEvent={(event) => console.log(event)}`);

  return [
    js(`1. Once, before anything renders:`),
    `import { initBraidReact } from '@braid/react';`,
    `initBraidReact();`,
    ``,
    js(`2. Where it should appear:`),
    `import { BraidFragment } from '@braid/react';`,
    ``,
    `export function Host() {`,
    `  return (`,
    ...notes.map((note) => `    ${note}`),
    `    <BraidFragment ${attributes.join(' ')} />`,
    `  );`,
    `}`,
  ].join('\n');
}

/**
 * What a reader needs to know before pasting, when there is anything.
 *
 * Only states that change what the host must *do*. "This fragment is gated" is worth a line
 * because the slot will render nothing for a user who lacks the role, and someone debugging that
 * without knowing it will go looking in the wrong place entirely.
 */
export function integrationWarnings(entry: DiscoveryEntry): string[] {
  const warnings: string[] = [];

  if (!entry.loadable) {
    warnings.push(
      'You may list this fragment but not load it. The markup below is correct; the slot will stay empty until your principal is allowed to fetch it.',
    );
  }

  if (isWidget(entry) && !entry.src) {
    warnings.push('This widget declares no `src`, so no host can embed it correctly yet. Fix the manifest first.');
  }

  if (!isWidget(entry) && entry.pierce?.length) {
    warnings.push(
      `This fragment renders the page's route. It is server-rendered into ${entry.pierce.join(', ')} — place the slot on one of those routes.`,
    );
  }

  if (!isWidget(entry) && !entry.pierce?.length) {
    warnings.push(
      'This fragment renders the page\'s route but pierces no route patterns, so it will only ever boot on the client.',
    );
  }

  return warnings;
}
