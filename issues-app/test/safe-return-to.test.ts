/**
 * safe-return-to.test.ts — coverage for app/_lib/safe-return-to.ts, the
 * open-redirect guard for the `returnTo` hidden field server actions in
 * app/actions.ts redirect back to after a mutation.
 *
 * Round-2 regression: a single ASCII TAB as the second character
 * (`/\t//evil.example`) bypassed the previous version's guard — the
 * negative lookahead only inspected the ONE character right after the
 * leading slash (a tab, not `/` or `\`), and the excluded-character class
 * omitted control characters entirely. Node's HTTP header validator
 * permits raw tabs in a Location header, and the WHATWG URL parser strips
 * all ASCII tab/newline characters before parsing, collapsing the value
 * back to `///evil.example` — a cross-origin redirect to evil.example.
 *
 * FAILS before the fix: safeReturnTo('/\t//evil.example') returns the
 * malicious value unchanged (bypasses the guard). PASSES after: it falls
 * back to the safe default.
 */
import { describe, expect, it } from 'vitest';
import { safeReturnTo } from '../app/_lib/safe-return-to.ts';

describe('safeReturnTo', () => {
  it('allows the literal values this app actually renders as hidden returnTo fields', () => {
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/issues')).toBe('/issues');
    expect(safeReturnTo('/issues/1ec74fd1-272c-4eac-bf0d-c46b6c7b7e09')).toBe('/issues/1ec74fd1-272c-4eac-bf0d-c46b6c7b7e09');
    expect(safeReturnTo('/issues?sort=due_date&dir=asc')).toBe('/issues?sort=due_date&dir=asc');
  });

  it('falls back on a protocol-relative URL (//host)', () => {
    expect(safeReturnTo('//evil.example', '/fallback')).toBe('/fallback');
  });

  it('falls back on an absolute URL', () => {
    expect(safeReturnTo('https://evil.example', '/fallback')).toBe('/fallback');
    expect(safeReturnTo('http://evil.example', '/fallback')).toBe('/fallback');
  });

  it('falls back on a backslash immediately after the leading slash', () => {
    expect(safeReturnTo('/\\evil.example', '/fallback')).toBe('/fallback');
    expect(safeReturnTo('/\\/evil.example', '/fallback')).toBe('/fallback');
  });

  it('REGRESSION: falls back on a tab-smuggled protocol-relative URL (round-2 bypass)', () => {
    // This exact payload passed the round-1 regex (`/^\/(?!\/)[^\\]*$/`):
    // the lookahead only checked the character right after the leading
    // slash (a tab, not `/`), and the char class allowed raw tabs through.
    expect(safeReturnTo('/\t//evil.example', '/fallback')).toBe('/fallback');
  });

  it('falls back on other C0 control characters anywhere in the value (LF, CR, NUL)', () => {
    expect(safeReturnTo('/issues\n//evil.example', '/fallback')).toBe('/fallback');
    expect(safeReturnTo('/issues\r//evil.example', '/fallback')).toBe('/fallback');
    expect(safeReturnTo('/issues\x00//evil.example', '/fallback')).toBe('/fallback');
  });

  it('falls back on an empty or non-leading-slash value', () => {
    expect(safeReturnTo('', '/fallback')).toBe('/fallback');
    expect(safeReturnTo('evil.example', '/fallback')).toBe('/fallback');
  });

  it('trims leading/trailing whitespace before validating (matches str()\'s existing behavior)', () => {
    expect(safeReturnTo('  /issues  ')).toBe('/issues');
  });
});
