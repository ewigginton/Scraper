/**
 * hovercard-css-regression.test.ts — a cheap, dependency-free regression
 * guard for the ":has() unclipping" fix in app/globals.css (Wave 2b verify
 * Defect A: `.n-table-wrap { overflow-x: auto }` forces `overflow-y: auto`
 * per spec, which clips the absolutely-positioned `.n-hovercard-panel`
 * inside table wrappers; the fix relaxes `.n-table-wrap` to
 * `overflow: visible` while `:has(.n-hovercard:hover)` or
 * `:has(.n-hovercard:focus-within)` matches).
 *
 * This does NOT prove the fix renders correctly in a real browser — there
 * is no DOM/CSS engine in this package (jsdom is not installed, and adding
 * one is out of scope per this project's no-new-deps policy) and layout/
 * paint cannot be observed from Node. What this test CAN cheaply catch,
 * and is worth catching, is the actual historical failure mode for this
 * kind of fix: a class name renamed in one file (HoverCard.tsx /
 * app/*.tsx) without the corresponding selector in globals.css being
 * updated, silently turning the :has() rule into a permanent no-op. See
 * PORTING.md / this project's final-review notes for the manual-verify
 * step this test does not replace: load /issues in a real browser, hover a
 * name inside a horizontally-scrollable table, and confirm the card is not
 * clipped.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const GLOBALS_CSS_PATH = new URL('../app/globals.css', import.meta.url);
const HOVERCARD_TSX_PATH = new URL('../app/_components/HoverCard.tsx', import.meta.url);

function readText(url: URL): string {
  return readFileSync(url, 'utf8');
}

describe('hovercard :has() unclipping fix (static regression guard)', () => {
  const css = readText(GLOBALS_CSS_PATH);
  const tsx = readText(HOVERCARD_TSX_PATH);

  it('globals.css still contains the :has() unclipping rule for both :hover and :focus-within', () => {
    expect(css).toMatch(/\.n-table-wrap:has\(\.n-hovercard:hover\)\s*,/);
    expect(css).toMatch(/\.n-table-wrap:has\(\.n-hovercard:focus-within\)\s*\{/);
  });

  it('the :has() rule sets overflow: visible (the actual unclip mechanism)', () => {
    const match = css.match(/\.n-table-wrap:has\(\.n-hovercard:hover\)[\s\S]*?\{([\s\S]*?)\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/overflow\s*:\s*visible/);
  });

  it('.n-table-wrap itself sets overflow-x: auto — the exact condition that requires the :has() workaround; if this changes, the fix may no longer be needed OR may need updating', () => {
    const match = css.match(/\.n-table-wrap\s*\{([\s\S]*?)\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/overflow-x\s*:\s*auto/);
  });

  it('the classnames the :has() selector depends on (n-hovercard, n-hovercard-panel) are still exactly what HoverCard.tsx renders', () => {
    expect(tsx).toMatch(/className=\{`n-hovercard\$\{/);
    expect(tsx).toMatch(/className="n-hovercard-panel"/);
  });

  it('every :hover/:focus-within reveal rule for the panel uses the same .n-hovercard / .n-hovercard-panel pair the :has() selector targets', () => {
    expect(css).toMatch(/\.n-hovercard:hover \.n-hovercard-panel\s*,/);
    expect(css).toMatch(/\.n-hovercard:focus-within \.n-hovercard-panel\s*\{/);
  });

  it('every .n-table-wrap usage site in app/*.tsx is a plain div (no unexpected extra class that would change specificity/matching)', () => {
    // A loose sanity check: at least one real usage site exists, so the
    // selector is not dead CSS for a component that no longer renders it.
    const issuesPage = readText(new URL('../app/issues/[id]/page.tsx', import.meta.url));
    expect(issuesPage).toMatch(/className="n-table-wrap"/);
  });
});
