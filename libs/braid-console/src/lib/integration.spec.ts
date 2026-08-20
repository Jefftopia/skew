import { describe, expect, it } from 'vitest';
import type { DiscoveryEntry } from '@skewkit/braid-gateway';
import { allIntegrationSnippets, integrationSnippet, integrationWarnings } from './integration.js';

function entry(overrides: Partial<DiscoveryEntry> & { id: string }): DiscoveryEntry {
  return {
    title: overrides.id,
    adapter: 'compat',
    mount: `/__braid/frag/${overrides.id}/`,
    loadable: true,
    bound: true,
    ...overrides,
  };
}

describe('integrationSnippet', () => {
  const screen = entry({ id: 'billing', pierce: ['/billing/*'] });

  it('names the fragment in every target', () => {
    for (const snippet of allIntegrationSnippets(screen)) {
      expect(snippet.code).toContain('billing');
    }
  });

  it('includes the one-time setup, not just the markup', () => {
    // A snippet that shows only the slot produces one that never boots, and the reader has no way
    // to know which half is missing.
    expect(integrationSnippet(screen, 'html').code).toContain("import { initBraid } from '@skewkit/braid';");
    expect(integrationSnippet(screen, 'angular').code).toContain('provideBraid');
    expect(integrationSnippet(screen, 'react').code).toContain('initBraidReact');
  });

  it('emits the element each binding actually ships', () => {
    expect(integrationSnippet(screen, 'html').code).toContain('<fragment-slot name="billing">');
    expect(integrationSnippet(screen, 'angular').code).toContain('<braid-fragment name="billing"');
    expect(integrationSnippet(screen, 'react').code).toContain('<BraidFragment name="billing"');
  });

  // A widget embedded without its src renders an empty shell on every page.
  it('includes src for a widget, in every target', () => {
    const widget = entry({ id: 'notifications', bound: false, src: '/panel' });

    for (const snippet of allIntegrationSnippets(widget)) {
      expect(snippet.code).toContain('/panel');
    }
  });

  it('never invents a src for a bound fragment', () => {
    expect(integrationSnippet(screen, 'html').code).not.toContain('src=');
  });

  // Guessing a path here would produce a snippet that looks right and 404s.
  it('says so rather than guessing when a widget declares no src', () => {
    const broken = entry({ id: 'orphan', bound: false });
    const code = integrationSnippet(broken, 'html').code;

    expect(code).not.toContain('src=');
    expect(code).toContain('declares no "src"');
  });

  it('shows props and events only for custom-element fragments', () => {
    const widget = entry({ id: 'rating', adapter: 'custom-element', bound: false, src: '/star.js' });

    expect(integrationSnippet(widget, 'angular').code).toContain('[props]');
    expect(integrationSnippet(widget, 'react').code).toContain('props={{}}');
    expect(integrationSnippet(screen, 'angular').code).not.toContain('[props]');
    // Plain HTML has no binding syntax, so props have to be shown as a property assignment.
    expect(integrationSnippet(widget, 'html').code).toContain('slot.props =');
    expect(integrationSnippet(screen, 'html').code).not.toContain('slot.props =');
  });
});

describe('integrationWarnings', () => {
  it('warns that a gated fragment will render nothing for this caller', () => {
    const gated = entry({ id: 'payroll', loadable: false, pierce: ['/payroll/*'] });

    expect(integrationWarnings(gated).some((warning) => warning.includes('not load it'))).toBe(true);
  });

  it('names the routes a bound fragment is pierced into', () => {
    const warnings = integrationWarnings(entry({ id: 'billing', pierce: ['/billing/*'] }));

    expect(warnings.some((warning) => warning.includes('/billing/*'))).toBe(true);
  });

  it('flags a widget with no src as unembeddable rather than merely awkward', () => {
    const warnings = integrationWarnings(entry({ id: 'orphan', bound: false }));

    expect(warnings.some((warning) => warning.includes('no host can embed it'))).toBe(true);
  });

  it('says nothing surprising about an ordinary loadable widget', () => {
    expect(integrationWarnings(entry({ id: 'notifications', bound: false, src: '/panel' }))).toEqual([]);
  });
});
