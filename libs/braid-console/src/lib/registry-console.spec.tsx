import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiscoveryEntry, DiscoveryPage } from '@skewkit/braid-gateway';
import { RegistryConsole, filterEntries } from './registry-console.js';
import { fetchRegistry } from './client.js';

const entry = (over: Partial<DiscoveryEntry> = {}): DiscoveryEntry => ({
  id: 'billing',
  title: 'Billing',
  adapter: 'compat',
  mount: '/__braid/frag/billing/',
  pierce: ['/billing/*'],
  loadable: true,
  ...over,
});

const page = (items: DiscoveryEntry[], over: Partial<DiscoveryPage> = {}): DiscoveryPage => ({
  items,
  page: 1,
  pageSize: 100,
  total: items.length,
  totalPages: 1,
  hasMore: false,
  protocolVersion: '2',
  ...over,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchRegistry', () => {
  it('follows pagination to the end', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page([entry({ id: 'a' })], { hasMore: true, totalPages: 2, total: 2 })))
      .mockResolvedValueOnce(jsonResponse(page([entry({ id: 'b' })], { page: 2, totalPages: 2, total: 2 })));

    const listing = await fetchRegistry({ fetch: fetchMock as unknown as typeof fetch });

    expect(listing.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops rather than looping when a gateway always reports more', async () => {
    // a fresh Response per call — a body can only be read once
    const fetchMock = vi.fn(async () => jsonResponse(page([entry()], { hasMore: true, totalPages: 3 })));

    await fetchRegistry({ fetch: fetchMock as unknown as typeof fetch });

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('sends host-supplied headers, so the console never owns a session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([])));

    await fetchRegistry({ fetch: fetchMock as unknown as typeof fetch, headers: () => ({ authorization: 'Bearer t' }) });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer t' });
  });

  it('explains a 404 as discovery being off rather than as a missing page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 404));

    await expect(fetchRegistry({ fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/Discovery is off/);
  });

  it('names an authorization failure as one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 403));

    await expect(fetchRegistry({ fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/Not authorized/);
  });
});

describe('filterEntries', () => {
  const entries = [
    entry({ id: 'billing', tags: ['finance'] }),
    entry({ id: 'reviews', title: 'Reviews', pierce: ['/reviews/*'], tags: [] }),
  ];

  it('returns everything for an empty query', () => {
    expect(filterEntries(entries, '   ')).toHaveLength(2);
  });

  it('matches on id, tag, and route — everything a row shows', () => {
    expect(filterEntries(entries, 'billing').map((e) => e.id)).toEqual(['billing']);
    expect(filterEntries(entries, 'finance').map((e) => e.id)).toEqual(['billing']);
    expect(filterEntries(entries, '/reviews/').map((e) => e.id)).toEqual(['reviews']);
  });
});

describe('<RegistryConsole>', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.getElementById('braid-console-styles')?.remove();
  });

  async function render(props: Parameters<typeof RegistryConsole>[0]) {
    await act(async () => {
      root.render(<RegistryConsole {...props} />);
    });
  }

  it('lists registered fragments', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([entry(), entry({ id: 'reviews', title: 'Reviews' })])));

    await render({ api: { fetch: fetchMock as unknown as typeof fetch } });

    expect(container.textContent).toContain('billing');
    expect(container.textContent).toContain('reviews');
    // The total lives in the summary strip rather than beside the title, so it is asserted as the
    // labelled statistic it now is rather than as a sentence fragment.
    expect(container.textContent).toContain('Fragments registered');
    expect(container.querySelector('.braid-console__statvalue')?.textContent).toBe('2');
  });

  it('injects its stylesheet exactly once per document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([entry()])));

    await render({ api: { fetch: fetchMock as unknown as typeof fetch } });
    const second = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => second.render(<RegistryConsole api={{ fetch: fetchMock as unknown as typeof fetch }} />));

    expect(document.querySelectorAll('#braid-console-styles')).toHaveLength(1);
    act(() => second.unmount());
  });

  it('scopes every style rule, so a host page is never restyled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([entry()])));
    await render({ api: { fetch: fetchMock as unknown as typeof fetch } });

    // Walk the parsed CSSOM rather than pattern-matching the source: a regex over CSS mistakes
    // declarations for selectors, and this assertion is only worth having if it is exact.
    const style = document.getElementById('braid-console-styles') as HTMLStyleElement;
    const selectors = collectSelectors(style.sheet!.cssRules);

    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) {
      expect(selector).toMatch(/^\.braid-console/);
    }
  });

  it('shows a fragment the caller may list but not load as gated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([entry({ loadable: false })])));

    await render({ api: { fetch: fetchMock as unknown as typeof fetch } });

    expect(container.textContent).toContain('gated');
  });

  it('warns when the gateway is in development mode and skipped filtering', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([entry()], { unfiltered: true })));

    await render({ api: { fetch: fetchMock as unknown as typeof fetch } });

    expect(container.textContent).toContain('development mode');
  });

  it('does not warn about filtering on a production gateway', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([entry()])));

    await render({ api: { fetch: fetchMock as unknown as typeof fetch } });

    expect(container.textContent).not.toContain('development mode');
  });

  it('reports a failure with a retry rather than an empty table', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));

    await render({ api: { fetch: fetchMock as unknown as typeof fetch } });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('failed with HTTP 500');
    expect(container.querySelector('.braid-console__retry')).not.toBeNull();
  });

  it('says so when nothing is registered', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([])));

    await render({ api: { fetch: fetchMock as unknown as typeof fetch } });

    expect(container.textContent).toContain('No fragments are registered');
  });

  it('honors an explicit theme over the OS setting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([entry()])));

    await render({ api: { fetch: fetchMock as unknown as typeof fetch }, theme: 'dark' });

    expect(container.querySelector('.braid-console')?.getAttribute('data-theme')).toBe('dark');
  });

  it('does not refetch when the caller passes a fresh api literal each render', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page([entry()])));
    const doFetch = fetchMock as unknown as typeof fetch;

    await render({ api: { baseUrl: 'https://gw.example', fetch: doFetch } });
    await render({ api: { baseUrl: 'https://gw.example', fetch: doFetch } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/** Every selector in a stylesheet, descending into grouping rules (@media, @container). */
function collectSelectors(rules: CSSRuleList): string[] {
  const selectors: string[] = [];

  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      selectors.push(...rule.selectorText.split(',').map((part) => part.trim()));
    } else if ('cssRules' in rule) {
      selectors.push(...collectSelectors((rule as CSSGroupingRule).cssRules));
    }
  }

  return selectors;
}
