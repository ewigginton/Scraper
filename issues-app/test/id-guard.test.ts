/**
 * id-guard.test.ts — coverage for lib/repositories/id-guard.ts's
 * containsNulByte guard, and the round-4 P2 finding: containsNulByte
 * itself (and one of this suite's own fixture files, comms-timeline.test.ts)
 * used to embed a LITERAL, unescaped NUL byte (U+0000) directly in their
 * source text rather than a `\u0000` escape sequence. Byte-identical
 * runtime behavior, but:
 *  - standard tooling (git diff, ripgrep, GitHub's PR view) classifies a
 *    file containing a raw NUL byte as binary and refuses to show/search
 *    its content — a real blocker for proposing this module elsewhere; and
 *  - a formatter/editor/encoding-normalization pass that ever silently
 *    dropped the byte would turn `value.includes('\0')` into
 *    `value.includes('')`, which is `true` for EVERY string — permanently
 *    rejecting every keyset cursor in the package (every 'issues'/
 *    'people'/'activity'/timeline feed pinned to page 1) with no error to
 *    hint at it.
 * This file covers both: containsNulByte's actual behavior, and a static
 * scan asserting the source files that used to carry the literal byte no
 * longer do.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { containsNulByte } from '../lib/repositories/id-guard.ts';

const ID_GUARD_PATH = new URL('../lib/repositories/id-guard.ts', import.meta.url);
const COMMS_TIMELINE_TEST_PATH = new URL('./comms-timeline.test.ts', import.meta.url);

function containsRawNulByte(url: URL): boolean {
  return readFileSync(url).includes(0);
}

describe('containsNulByte', () => {
  it('is false for an ordinary string, including empty — the guard test the round-4 finding notes was missing: this fails loudly if the NUL literal is ever normalized away into `value.includes(\'\')`, which would be true for every string', () => {
    expect(containsNulByte('abc')).toBe(false);
    expect(containsNulByte('')).toBe(false);
  });

  it('is true for a string containing a NUL byte, at the start, middle, or end', () => {
    expect(containsNulByte('\u0000')).toBe(true);
    expect(containsNulByte('\u0000abc')).toBe(true);
    expect(containsNulByte('ab\u0000cd')).toBe(true);
    expect(containsNulByte('abc\u0000')).toBe(true);
  });

  it('is stable across repeated calls on the same string (guards the stateful global-regex footgun this function\'s own doc comment calls out)', () => {
    expect(containsNulByte('a\u0000b')).toBe(true);
    expect(containsNulByte('a\u0000b')).toBe(true);
    expect(containsNulByte('a\u0000b')).toBe(true);
  });
});

// P2 regression (round 4): see this file's header doc comment.
describe('P2 regression (round 4): no literal NUL byte in source files (tooling must not classify these as binary)', () => {
  it('lib/repositories/id-guard.ts contains no raw NUL byte', () => {
    expect(containsRawNulByte(ID_GUARD_PATH)).toBe(false);
  });

  it('test/comms-timeline.test.ts contains no raw NUL byte', () => {
    expect(containsRawNulByte(COMMS_TIMELINE_TEST_PATH)).toBe(false);
  });
});
