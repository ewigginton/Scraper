/**
 * app/issues/page.tsx — the "All Issues" database view (docs/notion-redesign.md
 * "The All Issues database view", spec §15/§25). Server-rendered, fully
 * URL-driven: every control below is either a plain `<a>` href built through
 * app/_lib/issues-view.ts's buildIssuesHref, or a GET `<form>` whose fields
 * ARE the querystring — no client JS is required for filtering, sorting,
 * column visibility, grouping, or pagination to work.
 *
 * Data access goes through lib/repositories/issues-query-repo.ts (the sole
 * trust boundary for filters/sort/cursor — see that file's doc comment) and
 * app/_lib/issues-view.ts's loadGroupedIssues (group-by). This page never
 * touches drizzle directly.
 */

import { getCurrentUser } from '../../lib/auth/current-user.ts';
import { tryGetDb } from '../_lib/db.ts';
import { withActor } from '../../lib/db/actor-context.ts';
import { todayIso, formatDateTime } from '../_lib/dates.ts';
import { issueTypePillColor, lifecyclePillColor, priorityPillColor, humanize } from '../_lib/pills.ts';
import { propertyLabel } from '../_lib/reference-data.ts';
import { Pill } from '../_components/Pill.tsx';
import { DatabaseUnavailable, NoIssuesFound } from '../_components/EmptyState.tsx';
import { PropertyHoverCard } from '../_components/HoverCard.tsx';
import { ColumnsIcon } from '../_components/icons.tsx';
import { saveIssuesViewAction } from '../actions.ts';
import {
  countIssues,
  listIssues,
  resolveSort,
  type IssueListRow,
  type ResolvedSort,
  type SortDirection,
} from '../../lib/repositories/issues-query-repo.ts';
import {
  ALL_COLUMNS,
  ISSUE_TYPES,
  LIFECYCLE_STATUSES,
  PRIORITIES,
  TOGGLEABLE_COLUMNS,
  buildIssuesHref,
  loadGroupedIssues,
  parseIssuesViewParams,
  toPlainParamsObject,
  type ColumnDef,
  type ColumnKey,
  type GroupKey,
  type GroupSection,
  type IssuesHrefOverrides,
  type IssuesSearchParams,
} from '../_lib/issues-view.ts';

export const metadata = { title: 'All Issues — CCL Hub Issues' };

interface PageProps {
  searchParams: Promise<IssuesSearchParams>;
}

// Params each of the two GET forms below must replicate as hidden inputs so
// submitting one form doesn't silently drop the params the OTHER controls
// own (a plain GET form submission replaces the ENTIRE querystring with its
// own fields). `after` (the pagination cursor) is deliberately never
// preserved — any change to filters/sort/columns/group should restart
// pagination at page 1, never replay a cursor minted under different params.
const FILTER_FORM_PRESERVE_KEYS = ['sort', 'dir', 'cols'] as const;
const COLUMNS_FORM_PRESERVE_KEYS = ['type', 'status', 'state', 'priority', 'owner', 'overdue', 'q', 'sort', 'dir', 'group'] as const;

function firstString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function IssuesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const view = parseIssuesViewParams(sp);
  const db = tryGetDb();

  if (!db) {
    return (
      <>
        <h1>All Issues</h1>
        <DatabaseUnavailable />
      </>
    );
  }

  const user = await getCurrentUser();
  const today = todayIso();
  const resolvedSort = resolveSort(view.sort);
  const savedViewError = firstString(sp.savedViewError);

  // Single read transaction, actor context set once (see
  // lib/db/actor-context.ts's withActor doc comment — every authenticated
  // read in this package goes through this, never the bare `db` handle).
  // The total-count query always runs (it backs the header's count chip in
  // BOTH flat and grouped mode); which OTHER query runs depends on `group`.
  const result = await withActor(db, { actorId: user.id, roles: user.roles }, async (tx) => {
    const totalPromise = countIssues(tx, { filters: view.filters, today });
    if (view.group) {
      const [totalCount, groups] = await Promise.all([totalPromise, loadGroupedIssues(tx, view.filters, view.group, view.sort, today)]);
      return { mode: 'group' as const, totalCount, groups };
    }
    const [totalCount, flat] = await Promise.all([
      totalPromise,
      listIssues(tx, { filters: view.filters, sort: view.sort, cursor: view.cursor, today }),
    ]);
    return { mode: 'flat' as const, totalCount, flat };
  });

  return (
    <>
      <div className="n-toolbar">
        <div>
          <h1 className="n-page-title">All Issues</h1>
          <span className="n-count-chip">
            {result.totalCount} issue{result.totalCount === 1 ? '' : 's'}
          </span>
        </div>
        <SaveViewForm sp={sp} />
      </div>

      {savedViewError && (
        <div className="n-card n-blocker-card" role="alert" style={{ marginBottom: 'var(--space-md)' }}>
          <div className="n-blocker-reason">{savedViewError}</div>
        </div>
      )}

      <FilterBar sp={sp} view={view} />

      <div className="n-toolbar">
        <span className="muted">
          {result.mode === 'flat' ? `${result.flat.rows.length} row${result.flat.rows.length === 1 ? '' : 's'} on this page` : 'Grouped view'}
        </span>
        <ColumnsMenu sp={sp} view={view} />
      </div>

      {result.mode === 'group' ? (
        result.groups.length === 0 ? (
          <NoIssuesFound />
        ) : (
          result.groups.map((section) => (
            <GroupSectionBlock key={section.key} section={section} group={view.group as GroupKey} columns={view.columns} sp={sp} resolvedSort={resolvedSort} />
          ))
        )
      ) : result.flat.rows.length === 0 ? (
        <NoIssuesFound />
      ) : (
        <>
          <IssuesTable rows={result.flat.rows} columns={view.columns} sp={sp} resolvedSort={resolvedSort} />
          {result.flat.nextCursor && (
            <a className="n-load-more" href={buildIssuesHref(sp, { after: result.flat.nextCursor })}>
              Load next 50 &darr;
            </a>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------
// Filter bar — a single GET form (spec: "filter bar is a GET form (selects
// + text input + submit) so it works without client JS"). Group-by lives
// here too (also a plain URL param with no dedicated widget called out
// elsewhere in the spec).
// ---------------------------------------------------------------------

function FilterBar({ sp, view }: { sp: IssuesSearchParams; view: ReturnType<typeof parseIssuesViewParams> }) {
  const hasActiveFilters =
    view.filters.issueTypes!.length > 0 ||
    view.filters.lifecycleStatuses!.length > 0 ||
    view.filters.states!.length > 0 ||
    view.filters.priorities!.length > 0 ||
    Boolean(view.filters.coordinatorOrQueue) ||
    view.filters.overdueOnly ||
    Boolean(view.filters.searchText);

  return (
    <form method="get" action="/issues" className="n-filter-bar">
      <select name="type" multiple className="n-select" defaultValue={view.filters.issueTypes} aria-label="Issue type">
        {ISSUE_TYPES.map((t) => (
          <option key={t} value={t}>
            {humanize(t)}
          </option>
        ))}
      </select>

      <select name="status" multiple className="n-select" defaultValue={view.filters.lifecycleStatuses} aria-label="Lifecycle status">
        {LIFECYCLE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {humanize(s)}
          </option>
        ))}
      </select>

      <input
        type="text"
        name="state"
        className="n-input"
        style={{ width: '9rem' }}
        placeholder="State (e.g. TX, OK)"
        defaultValue={view.filters.states!.join(', ')}
        aria-label="State"
      />

      <select name="priority" multiple className="n-select" defaultValue={view.filters.priorities} aria-label="Priority">
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {humanize(p)}
          </option>
        ))}
      </select>

      <input
        type="text"
        name="owner"
        className="n-input"
        style={{ width: '11rem' }}
        placeholder="Coordinator / queue"
        defaultValue={view.filters.coordinatorOrQueue ?? ''}
        aria-label="Coordinator or queue"
      />

      <label className="n-filter-checkbox">
        <input type="checkbox" name="overdue" value="1" defaultChecked={view.filters.overdueOnly} />
        Overdue only
      </label>

      <input
        type="search"
        name="q"
        className="n-input"
        style={{ minWidth: '12rem' }}
        placeholder="Search issues, people, phone, tract..."
        defaultValue={view.filters.searchText ?? ''}
        aria-label="Search"
      />

      <select name="group" className="n-select" defaultValue={view.group ?? ''} aria-label="Group by">
        <option value="">No grouping</option>
        <option value="lifecycle_status">Group by stage</option>
        <option value="issue_type">Group by type</option>
      </select>

      <button type="submit" className="n-btn n-btn-primary">
        Apply
      </button>

      {hasActiveFilters && (
        <a
          className="n-btn n-btn-quiet"
          href={buildIssuesHref(sp, { type: null, status: null, state: null, priority: null, owner: null, overdue: null, q: null, after: null })}
        >
          Clear filters
        </a>
      )}

      <HiddenParams sp={sp} keys={FILTER_FORM_PRESERVE_KEYS} />
    </form>
  );
}

// ---------------------------------------------------------------------
// Columns menu — a native <details>/<summary> popover (no client JS) around
// a second small GET form (spec: "column menu ... may use small client
// components but must round-trip through the URL" — this round-trips
// without needing one).
// ---------------------------------------------------------------------

function ColumnsMenu({ sp, view }: { sp: IssuesSearchParams; view: ReturnType<typeof parseIssuesViewParams> }) {
  return (
    <details className="n-popover-wrap">
      <summary className="n-btn n-btn-quiet">
        <ColumnsIcon size={14} />
        Columns
      </summary>
      <form method="get" action="/issues" className="n-popover">
        {TOGGLEABLE_COLUMNS.map((col) => (
          <label key={col.key}>
            <input type="checkbox" name="cols" value={col.key} defaultChecked={view.columns.includes(col.key)} />
            {col.label}
          </label>
        ))}
        <HiddenParams sp={sp} keys={COLUMNS_FORM_PRESERVE_KEYS} />
        <button type="submit" className="n-btn n-btn-primary">
          Apply
        </button>
      </form>
    </details>
  );
}

/** Replays the current querystring's `keys` as hidden inputs, so submitting a form that only OWNS a subset of params doesn't drop the rest. `after` is never included here (see FILTER_FORM_PRESERVE_KEYS's doc comment). */
function HiddenParams({ sp, keys }: { sp: IssuesSearchParams; keys: readonly string[] }) {
  return (
    <>
      {keys.flatMap((key) => {
        const value = sp[key];
        if (value === undefined) return [];
        const values = Array.isArray(value) ? value : [value];
        return values.map((v, i) => <input key={`${key}-${i}`} type="hidden" name={key} value={v} />);
      })}
    </>
  );
}

// ---------------------------------------------------------------------
// Save view — server action form (spec §15). `params` is the JSON-encoded
// current view (filters/sort/columns/group, never the pagination cursor —
// see toPlainParamsObject's doc comment) that saved-view-service validates
// and saved-views-repo persists.
// ---------------------------------------------------------------------

function SaveViewForm({ sp }: { sp: IssuesSearchParams }) {
  const paramsJson = JSON.stringify(toPlainParamsObject(sp));
  const returnTo = buildIssuesHref(sp);
  return (
    <form action={saveIssuesViewAction} className="flex gap-sm items-center">
      <label htmlFor="saved-view-name" className="visually-hidden">
        Save current view as
      </label>
      <input id="saved-view-name" type="text" name="name" className="n-input" placeholder="View name" required maxLength={80} />
      <input type="hidden" name="params" value={paramsJson} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button type="submit" className="n-btn">
        Save view
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------
// Flat table
// ---------------------------------------------------------------------

function sortIndicator(resolvedSort: ResolvedSort, key: NonNullable<ColumnDef['sortKey']>): string {
  if (resolvedSort.key !== key) return '';
  return resolvedSort.direction === 'asc' ? ' ↑' : ' ↓';
}

function ColumnHeader({ col, sp, resolvedSort }: { col: ColumnDef; sp: IssuesSearchParams; resolvedSort: ResolvedSort }) {
  if (!col.sortKey) {
    return <th scope="col">{col.label}</th>;
  }
  const isActive = resolvedSort.key === col.sortKey;
  const nextDir: SortDirection = isActive && resolvedSort.direction === 'asc' ? 'desc' : 'asc';
  const href = buildIssuesHref(sp, { sort: col.sortKey, dir: nextDir, after: null });
  return (
    <th scope="col">
      <a className="n-sort-link" href={href}>
        {col.label}
        {sortIndicator(resolvedSort, col.sortKey)}
      </a>
    </th>
  );
}

function renderCell(colKey: ColumnKey, row: IssueListRow) {
  switch (colKey) {
    case 'property':
      return <PropertyHoverCard property={row.property} label={propertyLabel(row.property)} />;
    case 'type':
      return <Pill color={issueTypePillColor(row.issue.issueType)}>{humanize(row.issue.issueType)}</Pill>;
    case 'stage':
      return <Pill color={lifecyclePillColor(row.issue.lifecycleStatus)}>{humanize(row.issue.lifecycleStatus)}</Pill>;
    case 'priority':
      return <Pill color={priorityPillColor(row.issue.priority)}>{humanize(row.issue.priority)}</Pill>;
    case 'owner':
      // coordinatorId is a real staff identity string (never humanized); queue
      // is a snake_case enum key and IS humanized, matching Type/Stage/Priority's
      // treatment elsewhere in this table (visual-QA fix: raw "new_unreviewed"-
      // style strings were leaking into this column unformatted).
      return row.issue.coordinatorId ?? (row.issue.queue ? humanize(row.issue.queue) : '—');
    case 'state':
      return row.property.state ?? '—';
    case 'updated':
      return formatDateTime(row.issue.updatedAt);
  }
}

function IssueRow({ row, columns }: { row: IssueListRow; columns: ColumnKey[] }) {
  return (
    <tr>
      {columns.map((colKey, i) => (
        <td key={colKey}>
          {i === 0 && <a className="n-row-link" href={`/issues/${row.issue.id}`} aria-label={`Open case for ${propertyLabel(row.property)}`} />}
          {renderCell(colKey, row)}
        </td>
      ))}
      <td>
        <div className="n-row-actions">
          <a className="n-btn n-btn-quiet" href={`/issues/${row.issue.id}`}>
            Open &rarr;
          </a>
        </div>
      </td>
    </tr>
  );
}

function IssuesTable({
  rows,
  columns,
  sp,
  resolvedSort,
}: {
  rows: IssueListRow[];
  columns: ColumnKey[];
  sp: IssuesSearchParams;
  resolvedSort: ResolvedSort;
}) {
  return (
    <div className="n-table-wrap">
      <table className="n-table">
        <thead>
          <tr>
            {columns.map((colKey) => {
              const col = ALL_COLUMNS.find((c) => c.key === colKey);
              return col ? <ColumnHeader key={colKey} col={col} sp={sp} resolvedSort={resolvedSort} /> : null;
            })}
            <th scope="col" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <IssueRow key={row.issue.id} row={row} columns={columns} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------
// Group mode
// ---------------------------------------------------------------------

function groupViewAllHref(sp: IssuesSearchParams, group: GroupKey, value: string): string {
  const paramKey = group === 'lifecycle_status' ? 'status' : 'type';
  const overrides: IssuesHrefOverrides = { group: null, after: null, [paramKey]: [value] };
  return buildIssuesHref(sp, overrides);
}

function GroupHeaderPill({ group, value }: { group: GroupKey; value: string }) {
  return group === 'lifecycle_status' ? (
    <Pill color={lifecyclePillColor(value)}>{humanize(value)}</Pill>
  ) : (
    <Pill color={issueTypePillColor(value)}>{humanize(value)}</Pill>
  );
}

function GroupSectionBlock({
  section,
  group,
  columns,
  sp,
  resolvedSort,
}: {
  section: GroupSection;
  group: GroupKey;
  columns: ColumnKey[];
  sp: IssuesSearchParams;
  resolvedSort: ResolvedSort;
}) {
  return (
    <section className="n-group-section" aria-labelledby={`group-${section.key}`}>
      <div className="n-group-section-header" id={`group-${section.key}`}>
        <GroupHeaderPill group={group} value={section.key} />
        <span className="n-count-chip">{section.count}</span>
      </div>
      <IssuesTable rows={section.rows} columns={columns} sp={sp} resolvedSort={resolvedSort} />
      {section.count > section.rows.length && (
        <a className="n-load-more" href={groupViewAllHref(sp, group, section.key)}>
          View all {section.count} &rarr;
        </a>
      )}
    </section>
  );
}
