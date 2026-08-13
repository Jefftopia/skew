import { describe, expect, it } from 'vitest';
import { createNodesV2, name } from './plugin.js';

const [pattern, createNodes] = createNodesV2;
const context = { workspaceRoot: '/repo' };

describe('nx plugin', () => {
  it('matches braid config files anywhere in the workspace', () => {
    expect(name).toBe('braid');
    expect(pattern).toBe('**/braid.config.{json,mjs,js}');
  });

  it('infers a braid-dev target on the project holding the config', async () => {
    const results = await createNodes(['apps/shell/braid.config.json'], undefined, context);
    const [, entry] = results[0];

    expect(Object.keys(entry.projects)).toEqual(['apps/shell']);
    const target = entry.projects['apps/shell'].targets['braid-dev'];
    expect(target.command).toBe('braid dev --config braid.config.json');
    expect(target.options).toEqual({ cwd: 'apps/shell' });
  });

  it('marks the target continuous and uncached, because it is a dev server', async () => {
    const results = await createNodes(['apps/shell/braid.config.json'], undefined, context);
    const target = results[0][1].projects['apps/shell'].targets['braid-dev'];

    expect(target.cache).toBe(false);
    expect(target.continuous).toBe(true);
  });

  it('honors a configured target name', async () => {
    const results = await createNodes(['apps/shell/braid.config.json'], { targetName: 'compose' }, context);

    expect(Object.keys(results[0][1].projects['apps/shell'].targets)).toEqual(['compose']);
  });

  it('handles a config at the workspace root', async () => {
    const results = await createNodes(['braid.config.json'], undefined, context);

    expect(Object.keys(results[0][1].projects)).toEqual(['.']);
  });

  it('infers one target per config file', async () => {
    const results = await createNodes(
      ['apps/a/braid.config.json', 'apps/b/braid.config.mjs'],
      undefined,
      context,
    );

    expect(results).toHaveLength(2);
    expect(results[1][1].projects['apps/b'].targets['braid-dev'].command).toContain('braid.config.mjs');
  });

  it('falls back to a generic description when the config cannot be read', async () => {
    const results = await createNodes(['apps/missing/braid.config.json'], undefined, context);
    const target = results[0][1].projects['apps/missing'].targets['braid-dev'];

    expect(String(target.metadata?.['description'])).toContain('composed application');
  });
});
