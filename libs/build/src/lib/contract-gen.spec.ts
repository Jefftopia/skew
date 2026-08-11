import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateContractFile, generateContractModule, pascalCase } from './contract-gen.js';

const FUND_CONTRACT = {
  skewContract: '1',
  name: 'portfolio-fund',
  current: 2,
  steps: [
    {
      from: 1,
      to: 2,
      description: 'promote scalars to structure',
      ops: [{ rename: { from: 'currency', to: 'baseCurrency' } }],
    },
  ],
  schemas: {
    '1': {
      type: 'object',
      required: ['id', 'currency', 'nav'],
      properties: {
        id: { type: 'string' },
        currency: { type: 'string' },
        nav: { type: 'number' },
        note: { type: 'string' },
      },
    },
    '2': {
      type: 'object',
      required: ['id', 'baseCurrency', 'nav', 'holdings'],
      properties: {
        id: { type: 'string' },
        baseCurrency: { type: 'string' },
        nav: {
          type: 'object',
          required: ['amount', 'asOf'],
          properties: { amount: { type: 'number' }, asOf: { type: 'string' } },
        },
        holdings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['ticker', 'liquidityTier'],
            properties: {
              ticker: { type: 'string' },
              liquidityTier: { enum: ['T1', 'T2', 'T3'] },
            },
          },
        },
      },
    },
  },
};

describe('pascalCase', () => {
  it('handles kebab, snake, and mixed names', () => {
    expect(pascalCase('portfolio-fund')).toBe('PortfolioFund');
    expect(pascalCase('weekly_content')).toBe('WeeklyContent');
    expect(pascalCase('draft')).toBe('Draft');
  });
});

describe('generateContractModule', () => {
  const generated = generateContractModule(FUND_CONTRACT);

  it('emits one frozen interface per documented version', () => {
    expect(generated).toContain('export interface PortfolioFundV1 {');
    expect(generated).toContain('export interface PortfolioFundV2 {');
  });

  it('marks the current alias', () => {
    expect(generated).toContain('export type PortfolioFund = PortfolioFundV2;');
  });

  it('respects required vs optional properties', () => {
    expect(generated).toMatch(/note\?: string;/);
    expect(generated).toMatch(/currency: string;/);
  });

  it('renders nested objects, arrays, and enums', () => {
    expect(generated).toContain('amount: number;');
    expect(generated).toMatch(/liquidityTier: "T1" \| "T2" \| "T3";/);
    expect(generated).toMatch(/holdings: \{/);
  });

  it('embeds the document verbatim as a typed const', () => {
    expect(generated).toContain('export const portfolioFundContract = {');
    expect(generated).toContain('"skewContract": "1"');
    expect(generated).toContain('as const;');
  });

  it('warns readers the file is generated', () => {
    expect(generated).toContain('do not edit');
  });

  it('honours prefix and const-name overrides', () => {
    const custom = generateContractModule(FUND_CONTRACT, { typePrefix: 'Fund', constName: 'fundDoc' });
    expect(custom).toContain('export interface FundV1');
    expect(custom).toContain('export const fundDoc =');
  });

  it('rejects garbage that is not a contract document', () => {
    expect(() => generateContractModule({ hello: 'world' })).toThrow(/skewContract/);
  });

  it('copes with a document that documents no schemas — types are optional, the const is not', () => {
    const bare = generateContractModule({ ...FUND_CONTRACT, schemas: undefined });
    expect(bare).not.toContain('export interface');
    expect(bare).toContain('export const portfolioFundContract');
  });
});

describe('generateContractFile', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads JSON and writes the module, creating directories as needed', () => {
    dir = mkdtempSync(join(tmpdir(), 'skew-contract-gen-'));
    const input = join(dir, 'portfolio-fund.json');
    const output = join(dir, 'generated', 'portfolio-fund.contract.ts');
    writeFileSync(input, JSON.stringify(FUND_CONTRACT));

    const result = generateContractFile({ in: input, out: output });

    expect(result.name).toBe('portfolio-fund');
    const written = readFileSync(output, 'utf8');
    expect(written).toContain('export interface PortfolioFundV2');
  });
});
