import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FragmentManifest } from '@skewkit/braid-gateway';
import { RegistryEditor } from './registry-editor.js';

const manifests: FragmentManifest[] = [
  { id: 'billing', endpoint: 'https://billing.internal', pierce: ['/billing/*'], title: 'Billing' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake API: GET /head serves a pinned snapshot, POST /snapshots publishes. */
function fakeApi(over: { publish?: () => Response } = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];

  const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (url.endsWith('/head') && method === 'GET') {
      return json({ id: 'reg_base', snapshot: { id: 'reg_base', createdAt: '2026-01-01', manifests } });
    }
    if (url.endsWith('/snapshots') && method === 'POST') {
      return (
        over.publish?.() ??
        json(
          {
            snapshot: { id: 'reg_new', createdAt: '2026-08-14', fragmentCount: 1 },
            findings: [],
            descriptorNotes: [],
            pinned: true,
          },
          201,
        )
      );
    }
    return json({ error: 'unexpected' }, 404);
  });

  return { fetch: doFetch as unknown as typeof fetch, calls };
}

describe('<RegistryEditor>', () => {
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

  async function render(api: { fetch: typeof fetch }) {
    await act(async () => {
      root.render(<RegistryEditor api={api} />);
    });
  }

  /** By visible text. */
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);

  /** By accessible name, for icon-ish buttons whose text is not unique. */
  const byLabel = (label: string) =>
    [...container.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === label);

  const isDisabled = (label: string) => button(label)?.hasAttribute('disabled') ?? null;

  const click = async (element: Element | undefined) => {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('branches from the pinned snapshot', async () => {
    const api = fakeApi();
    await render(api);

    expect(container.textContent).toContain('reg_base');
    expect(container.textContent).toContain('billing');
  });

  it('starts with publish disabled, because nothing has changed', async () => {
    await render(fakeApi());

    expect(isDisabled('Publish')).toBe(true);
    expect(container.textContent).toContain('No changes');
  });

  it('enables publish once something changes', async () => {
    await render(fakeApi());
    await click(button('Add fragment'));

    // the new fragment has a blank endpoint, so it is changed *and* invalid
    expect(container.textContent).toContain('cannot publish');
    expect(isDisabled('Publish')).toBe(true);
  });

  it('refuses to publish a draft with errors, without contacting the server', async () => {
    const api = fakeApi();
    await render(api);
    await click(button('Add fragment'));
    await click(button('Publish'));

    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('publishes a valid change and reports the new snapshot', async () => {
    const api = fakeApi();
    await render(api);

    await click(byLabel('Remove billing'));
    await click(button('Publish'));

    const published = api.calls.find((call) => call.method === 'POST');
    expect(published?.body).toMatchObject({ manifests: [] });
    expect(container.textContent).toContain('reg_new');
    expect(container.textContent).toContain('now pinned');
  });

  it('re-bases after publishing, so the same content is not offered again', async () => {
    const api = fakeApi();
    await render(api);
    await click(byLabel('Remove billing'));
    await click(button('Publish'));

    expect(container.textContent).toContain('No changes');
    expect(isDisabled('Publish')).toBe(true);
  });

  it('discards edits back to the pinned snapshot', async () => {
    await render(fakeApi());
    await click(byLabel('Remove billing'));
    expect(container.textContent).not.toContain('billing');

    await click(button('Discard'));

    expect(container.textContent).toContain('billing');
    expect(container.textContent).toContain('No changes');
  });

  it('shows what the draft changes, labelled by owner', async () => {
    await render(fakeApi());
    await click(byLabel('Remove billing'));
    await click(button('Show changes'));

    expect(container.querySelector('.braid-console__diff')?.textContent).toContain('billing');
  });

  it('surfaces server-side findings when the server refuses', async () => {
    const api = fakeApi({
      publish: () =>
        json(
          {
            error: 'the registry has errors and was not published',
            findings: [{ severity: 'error', code: 'duplicate-id', message: 'server says no', fragmentIds: ['billing'] }],
          },
          422,
        ),
    });
    await render(api);
    await click(byLabel('Remove billing'));
    await click(button('Publish'));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('was not published');
    expect(alert?.textContent).toContain('server says no');
  });

  it('reports an authorization refusal in the server’s own words', async () => {
    const api = fakeApi({ publish: () => json({ error: 'not authorized to publish' }, 403) });
    await render(api);
    await click(byLabel('Remove billing'));
    await click(button('Publish'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not authorized to publish');
  });

  it('marks gateway-owned fields in the editor', async () => {
    await render(fakeApi());
    await click(container.querySelector('.braid-console__disclose'));

    const owners = [...container.querySelectorAll('.braid-console__owner')].map((element) => element.textContent);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every((text) => text === 'gateway')).toBe(true);
  });

  it('reports a failure to load rather than showing an empty editor', async () => {
    const doFetch = vi.fn(async () => json({ error: 'not authorized to read' }, 403));
    await render({ fetch: doFetch as unknown as typeof fetch });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not authorized to read');
  });
});
