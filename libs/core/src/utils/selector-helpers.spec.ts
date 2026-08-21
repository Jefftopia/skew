import { describe, test, expect } from 'vitest';
import { rewriteQuerySelector } from './selector-helpers.js';

describe('rewriteQuerySelector()', () => {
  test('Tag selectors (body) are rewritten', () => {
    expect(rewriteQuerySelector('html')).toBe('braid-html');
    expect(rewriteQuerySelector('head')).toBe('braid-head');
    expect(rewriteQuerySelector('body')).toBe('braid-body');

    // tag selectors are case-insensitive
    expect(rewriteQuerySelector('BODY')).toBe('braid-body');
  });

  test('Tag selectors with non-exact matches (bodybody) are preserved', () => {
    expect(rewriteQuerySelector('bodybody')).toBe('bodybody');
    expect(rewriteQuerySelector('htmlhead')).toBe('htmlhead');
  });

  test('Comma separated selectors (html, body) are rewritten', () => {
    expect(rewriteQuerySelector('html, body')).toBe('braid-html, braid-body');
  });

  test('Descendant combinators (html body) are rewritten', () => {
    expect(rewriteQuerySelector('html body')).toBe('braid-html braid-body');
  });

  test('Child combinators (html > body > div) are rewritten', () => {
    expect(rewriteQuerySelector('html > body > div')).toBe('braid-html > braid-body > div');
  });

  test('Subsequent sibling combinators (head~body) are rewritten', () => {
    expect(rewriteQuerySelector('html > head~body')).toBe('braid-html > braid-head~braid-body');
  });

  test('Next sibling combinators (head + body) are rewritten', () => {
    expect(rewriteQuerySelector('head+body')).toBe('braid-head+braid-body');
  });

  test('Complex queries (body>head, .body+head > body:hover") are rewritten', () => {
    expect(rewriteQuerySelector('body>head, .body+head > body:hover"')).toBe(
      'braid-body>braid-head, .body+braid-head > braid-body:hover"',
    );
  });

  test('Class selectors (.body) are preserved', () => {
    expect(rewriteQuerySelector('.body')).toBe('.body');
    expect(rewriteQuerySelector('html body.body')).toBe('braid-html braid-body.body');
  });

  test('ID selectors (#body) are preserved', () => {
    expect(rewriteQuerySelector('#body')).toBe('#body');
    expect(rewriteQuerySelector('html body#body .body')).toBe('braid-html braid-body#body .body');
  });

  test('Attribute selectors ([data-attr="body"]) are preserved', () => {
    expect(rewriteQuerySelector('html > div [data-attr="body"]')).toBe('braid-html > div [data-attr="body"]');
  });

  test('Non-matched selectors (div, p, a) are preserved', () => {
    expect(rewriteQuerySelector('div, p, a')).toBe('div, p, a');
  });

  test('Valid braid-(html|head|body) selectors are preserved', () => {
    expect(rewriteQuerySelector('braid-html, braid-head + braid-body')).toBe('braid-html, braid-head + braid-body');
  });

  test('Support array as an argument and stringify it', () => {
    expect(rewriteQuerySelector(['p', 'span'] as any)).toBe('p,span');
  });
});
