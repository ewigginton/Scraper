export function DatabaseUnavailable() {
  return (
    <div className="card" role="status">
      <h2>Database not configured</h2>
      <p>
        This screen needs a working <code>DATABASE_URL</code>. Copy{' '}
        <code>.env.example</code> to <code>.env.local</code>, point it at a
        Postgres/Supabase database with the Issues migrations applied, then
        restart the dev server.
      </p>
      <p className="muted">No data was read or written for this request.</p>
    </div>
  );
}

export function EmptyQueue({ label }: { label: string }) {
  return <p className="muted empty-queue">{label} — nothing here.</p>;
}

/** /issues "zero results" state — a filter/search combination matched nothing. Not an error: filters/sort/etc. are already allowlist-normalized before this ever renders, so this always means "no rows", never "bad params" (bad params fall back to defaults silently upstream). */
export function NoIssuesFound() {
  return (
    <div className="card" role="status">
      <p className="muted" style={{ marginBottom: 0 }}>
        No issues match these filters. Try widening the filters or clearing search.
      </p>
    </div>
  );
}
