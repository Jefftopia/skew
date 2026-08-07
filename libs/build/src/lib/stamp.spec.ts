import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBuildId, scanAssets, stamp } from './stamp.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'skew-build-'));
}

const originalEnv = process.env['SKEW_BUILD_ID'];
afterEach(() => {
  if (originalEnv === undefined) delete process.env['SKEW_BUILD_ID'];
  else process.env['SKEW_BUILD_ID'] = originalEnv;
});

describe('resolveBuildId', () => {
  it('prefers an explicit id', () => {
    process.env['SKEW_BUILD_ID'] = 'from-env';
    expect(resolveBuildId('explicit')).toBe('explicit');
  });

  it('falls back to the CI environment variable', () => {
    process.env['SKEW_BUILD_ID'] = 'from-env';
    expect(resolveBuildId()).toBe('from-env');
  });

  it('derives a stable id from git when available', () => {
    delete process.env['SKEW_BUILD_ID'];
    const id = resolveBuildId();
    // Either a short SHA or the random fallback — both must be non-empty and
    // free of whitespace, since this ends up in a header and a filename.
    expect(id).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe('stamp', () => {
  it('writes an identity module with both constants', () => {
    const dir = tempDir();

    const result = stamp({
      out: 'src/generated/build-id.ts',
      buildId: 'abc123',
      builtAt: '2026-08-07T10:00:00.000Z',
      cwd: dir,
    });

    const source = readFileSync(join(dir, 'src/generated/build-id.ts'), 'utf8');
    expect(source).toContain(`export const BUILD_ID = "abc123"`);
    expect(source).toContain(`export const BUILT_AT = "2026-08-07T10:00:00.000Z"`);
    expect(source).toContain('BUILD_IDENTITY');
    expect(result.buildId).toBe('abc123');
  });

  it('creates intermediate directories', () => {
    const dir = tempDir();
    stamp({ out: 'deeply/nested/path/id.ts', buildId: 'x', cwd: dir });
    expect(readFileSync(join(dir, 'deeply/nested/path/id.ts'), 'utf8')).toContain('BUILD_ID');
  });

  it('emits a manifest matching the identity', () => {
    const dir = tempDir();

    stamp({
      out: 'src/id.ts',
      manifest: 'dist/skew-manifest.json',
      buildId: 'build-9',
      builtAt: '2026-08-07T11:00:00.000Z',
      cwd: dir,
    });

    const manifest = JSON.parse(readFileSync(join(dir, 'dist/skew-manifest.json'), 'utf8'));
    expect(manifest.buildId).toBe('build-9');
    expect(manifest.builtAt).toBe('2026-08-07T11:00:00.000Z');
    // No asset dir scanned, so no modules key rather than an empty object —
    // consumers treat "absent" as "cannot classify", which is not the same as
    // "there are no modules".
    expect(manifest.modules).toBeUndefined();
  });

  it('includes scanned modules when an asset dir is given', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out/chunk-ABC123XYZ.js'), '');
    writeFileSync(join(dir, 'out/main-DEF456UVW.js'), '');
    writeFileSync(join(dir, 'out/styles.css'), '');

    stamp({ out: 'id.ts', manifest: 'm.json', assetDir: 'out', buildId: 'b', cwd: dir });

    const manifest = JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8'));
    expect(Object.keys(manifest.modules).sort()).toEqual(['chunk', 'main']);
    expect(manifest.modules.chunk.file).toBe('chunk-ABC123XYZ.js');
  });
});

describe('scanAssets', () => {
  it('strips content hashes to recover a logical key', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'admin-A1B2C3D4.js'), '');
    expect(scanAssets(dir)).toEqual({ admin: { file: 'admin-A1B2C3D4.js' } });
  });

  it('ignores non-JavaScript output', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'styles-ABC123.css'), '');
    writeFileSync(join(dir, 'logo.svg'), '');
    expect(scanAssets(dir)).toEqual({});
  });

  it('recurses into nested output directories', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested/lazy-99AA88BB.js'), '');
    expect(scanAssets(dir)['lazy']?.file).toBe('nested/lazy-99AA88BB.js');
  });

  it('returns empty rather than throwing for a missing directory', () => {
    expect(scanAssets('/definitely/not/a/real/path')).toEqual({});
  });
});
