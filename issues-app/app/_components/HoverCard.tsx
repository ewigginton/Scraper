/**
 * HoverCard — pure-CSS popover (spec §15 "Hover cards"). No client JS: the
 * card is plain markup shown via `.n-hovercard:hover .n-hovercard-panel` /
 * `:focus-within` in app/globals.css, the same "details-free" idiom this
 * app already uses for its columns-menu popover (n-popover-wrap), just
 * without the <details> element since a hover card must open on hover, not
 * click. `trigger` is usually a plain in-ecosystem link (an <a> to
 * /people/[id] or the property's own row/section) — the hover card adds
 * "peek without leaving the page" on top of that link, it never replaces
 * it (spec §15's "quick links" stay real hrefs the user can also just
 * click through to).
 */

export interface HoverCardProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  /** Rendered className passed through to the outer wrapper span, in addition to n-hovercard. */
  className?: string;
}

export function HoverCard({ trigger, children, className }: HoverCardProps) {
  return (
    <span className={`n-hovercard${className ? ` ${className}` : ''}`}>
      {trigger}
      <span className="n-hovercard-panel" role="note">
        {children}
      </span>
    </span>
  );
}
