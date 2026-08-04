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

import { humanize } from '../_lib/pills.ts';
import { displayableContactEntries } from '../_lib/reference-data.ts';
import type { PersonRef, PropertyRef } from '../../lib/db/schema.ts';

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

// ---------------------------------------------------------------------
// PersonHoverCard — applied to linked-people names (case page, /issues
// rows once a person column exists). Shows the contact_snapshot + role,
// with a quick link to the full /people/[id] profile.
// ---------------------------------------------------------------------

export interface PersonHoverCardProps {
  person: Pick<PersonRef, 'id' | 'displayName' | 'contactSnapshot'>;
  /** e.g. issue_people.role ("owner", "buyer_prospect", ...) — omitted when this trigger has no case-specific role (e.g. a bare /people index row). */
  role?: string | null;
  className?: string;
}

/** Wraps a plain `<a href="/people/[id]">{displayName}</a>` trigger (in-ecosystem link, spec requirement — never omitted even though the hover card itself also links) with a contact-snapshot + role peek card. */
export function PersonHoverCard({ person, role, className }: PersonHoverCardProps) {
  const contacts = displayableContactEntries(person.contactSnapshot);
  return (
    <HoverCard
      className={className}
      trigger={
        <a href={`/people/${person.id}`}>{person.displayName}</a>
      }
    >
      <span className="n-hovercard-title">{person.displayName}</span>
      {role && <span className="n-hovercard-row">Role: {humanize(role)}</span>}
      {contacts.length === 0 ? (
        <span className="n-hovercard-row">No contact details on file.</span>
      ) : (
        contacts.map(([k, v]) => (
          <span className="n-hovercard-row" key={k}>
            {humanize(k)}: {v}
          </span>
        ))
      )}
      <span className="n-hovercard-links">
        <a href={`/people/${person.id}`}>Open profile &rarr;</a>
      </span>
    </HoverCard>
  );
}

// ---------------------------------------------------------------------
// PropertyHoverCard — applied to property display names (case page,
// /issues rows). Shows state/county/development/tract plus a map link
// when property_refs.map_link is present.
// ---------------------------------------------------------------------

export interface PropertyHoverCardProps {
  property: Pick<PropertyRef, 'state' | 'county' | 'development' | 'tract' | 'mapLink'>;
  /** Rendered trigger — usually the property's display label, plain text or a link the caller already built. */
  label: React.ReactNode;
  className?: string;
}

export function PropertyHoverCard({ property, label, className }: PropertyHoverCardProps) {
  return (
    <HoverCard className={className} trigger={label}>
      <span className="n-hovercard-title">Property</span>
      <span className="n-hovercard-row">State: {property.state ?? '—'}</span>
      <span className="n-hovercard-row">County: {property.county ?? '—'}</span>
      <span className="n-hovercard-row">Development: {property.development ?? '—'}</span>
      <span className="n-hovercard-row">Tract: {property.tract ?? '—'}</span>
      {property.mapLink && (
        <span className="n-hovercard-links">
          <a href={property.mapLink} target="_blank" rel="noopener noreferrer">
            View map &rarr;
          </a>
        </span>
      )}
    </HoverCard>
  );
}
