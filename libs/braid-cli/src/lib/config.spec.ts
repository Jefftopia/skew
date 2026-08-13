import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';

const at = '/repo/braid.config.json';

describe('resolveConfig()', () => {
  it('infers a url from a port', () => {
    const config = resolveConfig(
      { shell: { port: 4200 }, fragments: [{ id: 'billing', dev: { port: 4201 } }] },
      at,
    );

    expect(config.shell.url).toBe('http://localhost:4200');
    expect(config.fragments[0].endpoint).toBe('http://localhost:4201');
  });

  it('lets an explicit endpoint override the dev url, so a dev server can be namespaced', () => {
    // the endpoint carries the prefix the fragment's dev server is configured to serve under
    const config = resolveConfig(
      {
        shell: { port: 4200 },
        fragments: [
          { id: 'billing', endpoint: 'http://localhost:4201/__braid/frag/billing', dev: { port: 4201 } },
        ],
      },
      at,
    );

    expect(config.fragments[0].endpoint).toBe('http://localhost:4201/__braid/frag/billing');
    expect(config.fragments[0].dev?.url).toBe('http://localhost:4201');
  });

  it('defaults the composed port', () => {
    expect(resolveConfig({ shell: { port: 4200 }, fragments: [] }, at).port).toBe(4000);
  });

  it('resolves a relative cwd against the config file', () => {
    const config = resolveConfig(
      { shell: { port: 4200, command: 'npm start', cwd: 'apps/shell' }, fragments: [] },
      at,
    );

    expect(config.shell.cwd).toBe('/repo/apps/shell');
  });

  it('defaults cwd to the config directory', () => {
    const config = resolveConfig({ shell: { port: 4200, command: 'npm start' }, fragments: [] }, at);

    expect(config.shell.cwd).toBe('/repo');
  });

  it('refuses a target with neither url nor port', () => {
    expect(() => resolveConfig({ shell: { command: 'npm start' }, fragments: [] }, at)).toThrow(/needs a "url"/);
  });

  it('refuses a fragment with nothing to point at', () => {
    expect(() => resolveConfig({ shell: { port: 4200 }, fragments: [{ id: 'orphan' }] }, at)).toThrow(
      /needs an "endpoint"/,
    );
  });

  it('keeps manifest fields the gateway cares about', () => {
    const config = resolveConfig(
      {
        shell: { port: 4200 },
        fragments: [{ id: 'billing', dev: { port: 4201 }, pierce: ['/billing/*'], title: 'Billing' }],
      },
      at,
    );

    expect(config.fragments[0]).toMatchObject({ id: 'billing', pierce: ['/billing/*'], title: 'Billing' });
  });
});
