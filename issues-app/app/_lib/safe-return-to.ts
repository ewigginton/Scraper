/**
 * app/_lib/safe-return-to.ts — validates the `returnTo` hidden-field value
 * server actions in app/actions.ts redirect back to after a mutation.
 *
 * Pulled out of app/actions.ts (a `'use server'` file, where every
 * top-level export must be an async Server Action) into its own plain
 * module so it can be unit-tested directly without importing next/
 * navigation's redirect()/revalidatePath(), which require a real Next.js
 * request context to run.
 *
 * ADVERSARIAL-REVIEW FIX (P2 open redirect): `returnTo` used to be read
 * straight off user-controlled form data with no validation and passed
 * unvalidated to redirect()/revalidatePath() — a hidden field an attacker
 * controls (or same-origin HTML injection) could set it to an absolute or
 * protocol-relative URL (`https://evil.example`, `//evil.example`) and the
 * server action would issue a redirect to it. The only legitimate values
 * are the hidden inputs this app itself renders (`/`, `/issues`,
 * `/issues/${id}`, and buildIssuesHref(sp)'s `/issues?...` filtered-view
 * URLs), so requiring a single leading slash (rejecting the
 * protocol-relative `//host` form, backslash variants, and absolute URLs)
 * loses nothing.
 *
 * FIX ROUND 2 (P2, still CONFIRMED bypassable): the previous version's
 * negative lookahead `(?!\/)` only inspected the ONE character immediately
 * after the leading slash, and `[^\\]*` excluded backslash but no other
 * control character — so `/\t//evil.example` (a literal ASCII TAB as the
 * second character) passed the regex outright. Node's HTTP header
 * validator permits raw U+0009 in a header value, so `Location:
 * /\t//evil.example` was emitted intact; the WHATWG URL parser then strips
 * ALL ASCII tab/newline characters before parsing, collapsing that back to
 * `///evil.example`, which resolves to a cross-origin redirect to
 * evil.example. `.trim()` does not strip an INTERIOR tab, only
 * leading/trailing whitespace, so the malicious character survives into
 * this check. Now excludes every C0 control character (\x00-\x1f, which
 * includes tab/CR/LF) anywhere in the string, and rejects a backslash
 * immediately after the leading slash too (not just later in the string).
 */
export function safeReturnTo(rawValue: string, fallback = '/'): string {
  const v = typeof rawValue === 'string' ? rawValue.trim() : '';
  // eslint-disable-next-line no-control-regex -- excluding C0 control chars is the point of this check.
  return /^\/(?![\\/])[^\\\x00-\x1f]*$/.test(v) ? v : fallback;
}
