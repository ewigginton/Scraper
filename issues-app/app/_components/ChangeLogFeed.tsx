/**
 * app/_components/ChangeLogFeed.tsx — readable change-log upgrade for the
 * case page's History section (Wave 2b, roadmap "Change log everywhere" /
 * "issue-level change log upgrade", spec §29.2/§31.4). Renders
 * app/_lib/case-view.ts's HistoryEntry rows as plain-English lines with
 * field-level diffs computed from before/after jsonb by
 * app/_lib/audit-diff.ts, instead of a raw table:
 *
 *   Priority: Normal → High — coordinator-jane, Aug 3, 2026, 2:14 PM
 *
 * Multi-field changes render a primary "<action> — <actor>, <time>" line
 * plus a compact sub-list of the individual field diffs. Entries with no
 * computable diff (creation events, denial-shaped audit rows, phase
 * open/close entries with no before/after) fall back to "<action> —
 * <actor>, <time>" plus the reason/detail when present. Unchanged fields are
 * never shown (audit-diff.computeFieldDiffs already omits them).
 *
 * `AuditDiffLine` is exported separately so any OTHER screen rendering audit
 * rows can reuse the same plain-English rendering instead of re-deriving it
 * — app/people/[id]/page.tsx's timeline uses it for 'audit'-kind entries.
 */

import { computeFieldDiffs } from '../_lib/audit-diff.ts';
import { formatDateTime } from '../_lib/dates.ts';
import { historyCategoryPillColor, humanize } from '../_lib/pills.ts';
import { HISTORY_CATEGORY_LABELS, type HistoryEntry } from '../_lib/case-view.ts';
import { Pill } from './Pill.tsx';
import styles from './ChangeLogFeed.module.css';

export interface AuditDiffLineProps {
  /** Humanized label shown when no field-level diff can be computed, or as the primary line for a multi-field change (e.g. "Phase Transitioned", or a raw TimelineEntry.title for the person-timeline reuse). */
  fallbackLabel: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  actor: string | null;
  at: Date;
  /** Extra context shown only in the fallback (no-diff) case, e.g. "tasks 3f21a9c2". */
  detail?: string | null;
  /** Appends "— <actor>, <time>" to the primary line (this module's literal "Priority: Normal → High — <actor>, <time>" format). Set false when the caller already renders actor/time elsewhere (e.g. a shared time column) — default true. */
  showMeta?: boolean;
}

/** The reusable plain-English diff/fallback line — see this file's header doc comment. */
export function AuditDiffLine({ fallbackLabel, before, after, reason, actor, at, detail, showMeta = true }: AuditDiffLineProps) {
  const diffs = computeFieldDiffs(before, after);
  const meta = showMeta ? ` — ${actor ?? 'unattributed'}, ${formatDateTime(at)}` : '';

  if (diffs.length === 1) {
    const d = diffs[0]!;
    return (
      <div className={styles.diffLine}>
        <div className={styles.primary}>
          {d.label}: {d.before} &rarr; {d.after}
          {showMeta && <span className={styles.meta}>{meta}</span>}
        </div>
        {reason && <div className={styles.reasonLine}>Reason: {reason}</div>}
      </div>
    );
  }

  if (diffs.length > 1) {
    return (
      <div className={styles.diffLine}>
        <div className={styles.primary}>
          {fallbackLabel}
          {showMeta && <span className={styles.meta}>{meta}</span>}
        </div>
        <ul className={styles.subList}>
          {diffs.map((d) => (
            <li key={d.field}>
              {d.label}: {d.before} &rarr; {d.after}
            </li>
          ))}
        </ul>
        {reason && <div className={styles.reasonLine}>Reason: {reason}</div>}
      </div>
    );
  }

  return (
    <div className={styles.diffLine}>
      <div className={styles.primary}>
        {fallbackLabel}
        {showMeta && <span className={styles.meta}>{meta}</span>}
      </div>
      {detail && <div className={styles.detailLine}>{detail}</div>}
      {reason && <div className={styles.reasonLine}>Reason: {reason}</div>}
    </div>
  );
}

/** Default export: the full readable feed for a HistoryEntry[] page — drop-in replacement for the case page's old History `<table>`. Category filter form + "Load more" pagination stay owned by the caller (app/issues/[id]/page.tsx already has both); this component is just the row rendering. */
export default function ChangeLogFeed({ entries }: { entries: HistoryEntry[] }) {
  return (
    <div className={styles.feed}>
      {entries.map((entry) => (
        <div key={entry.id} className={styles.entryRow}>
          <Pill color={historyCategoryPillColor(entry.category)}>{HISTORY_CATEGORY_LABELS[entry.category]}</Pill>
          <div className={styles.entryBody}>
            <AuditDiffLine
              fallbackLabel={humanize(entry.action)}
              before={entry.before}
              after={entry.after}
              reason={entry.reason}
              actor={entry.actor}
              at={entry.occurredAt}
              detail={entry.detail}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
