/**
 * Focused repro (reliability review, not part of the shipped suite): proves
 * that the "best-effort actor context on db too" pattern in
 * app/actions.ts:150 (a bare, non-transactional setActorContext(db, ...)
 * call followed later by a non-transactional audit insert on the same
 * top-level `db` handle, e.g. transition-engine.recordDenial's `auditDb`)
 * does NOT reach the eventual INSERT under a real non-owner/RLS-forced
 * connection, because set_config(..., true) ("is_local") resets at the end
 * of the implicit single-statement transaction that wraps it when called
 * outside an explicit BEGIN. This mirrors exactly what
 * app/actions.ts:150/167 does: `setActorContext(db, ...)` then, later,
 * `transitionEngine.transitionPhase(tx, ..., db)` which calls
 * `writeAudit(db, ...)` (via recordDenial) on a denial.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents } from '../lib/db/schema.ts';
import { closeTestDb, createTestDb, setActorContext, type TestDbHandle } from './helpers/pglite.ts';

const TEST_ROLE = 'issues_rls_test_role_denial_repro';

describe('repro: non-transactional setActorContext does not persist to a later non-transactional insert', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
    await handle.client.exec(`create role ${TEST_ROLE} nosuperuser noinherit login;`);
    await handle.client.exec(
      `grant select, insert, update, delete on issues, holds, evidence_files, config_versions, config_entries, audit_events, property_refs, person_refs, phase_instances, tasks to ${TEST_ROLE};`,
    );
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('reproduces the exact app/actions.ts sequence: setActorContext(db,...) then a later db-level (non-tx) audit insert fails RLS', async () => {
    const issueId = randomUUID();
    await handle.client.exec(`set role ${TEST_ROLE};`);

    // Step 1: exactly app/actions.ts:150 — "best-effort actor context on db too"
    await setActorContext(handle.db, 'actor-coordinator', ['coordinator']);

    // Step 2: exactly what recordDenial does on `auditDb` (== top-level `db`,
    // NOT `tx`) when a transition is denied — a plain insert on the
    // top-level handle, no explicit transaction wrapping it.
    let thrown: unknown;
    try {
      await handle.db.insert(auditEvents).values({
        actorExternalId: 'actor-coordinator',
        actorRole: 'coordinator',
        action: 'phase_transition_denied',
        objectTable: 'issues',
        objectId: issueId,
        before: { phaseKey: 'intake' },
        after: { attemptedPhaseKey: 'released', denialCode: 'not_eligible', reasons: ['active hold'] },
        source: 'transition-engine.transitionPhase',
      });
    } catch (err) {
      thrown = err;
    }

    // If the fix worked, this insert would succeed (actor context reached
    // it) and `thrown` would be undefined. It is NOT undefined: the GUC set
    // in step 1 evaporated the instant that statement's own implicit
    // transaction committed, so issues_current_actor() is null here and the
    // audit_events_insert_any_authenticated RLS policy (with check
    // issues_current_actor() is not null) rejects the insert.
    expect(thrown, 'EXPECTED (bug reproduction): the denial-audit insert is rejected by RLS because the earlier non-transactional setActorContext call never reached it').toBeDefined();
    const cause = thrown instanceof Error ? (thrown as Error & { cause?: unknown }).cause : undefined;
    const causeMessage = cause instanceof Error ? cause.message : '';
    const message = thrown instanceof Error ? `${thrown.message} ${causeMessage}` : String(thrown);
    expect(message).toMatch(/row-level security/i);
  });
});

// =====================================================================
// FIX VERIFICATION (this round): transition-engine.recordDenial no longer
// relies on the broken pattern above at all — it opens its OWN short-lived
// transaction on `auditDb` and sets actor context inside it before writing,
// so it is self-sufficient regardless of whether the caller's `auditDb`
// handle has any actor context already established on it (in production,
// app/actions.ts's bare top-level `db` never does — see the removed
// `setActorContext(db, ...)` call this test file's first describe block
// documents as a guaranteed no-op). This proves the actual command path
// (transitionPhase denying a transition) now persists its denial audit row
// under a real non-owner, FORCE-RLS role — the exact configuration the
// first describe block's repro shows the OLD pattern failing under.
// =====================================================================
import { eq, and } from 'drizzle-orm';
import { transitionPhase, TransitionError } from '../lib/services/transition-engine.ts';
import { createIssue } from '../lib/services/issue-service.ts';
import { setActorContext as pgliteSetActorContext } from './helpers/pglite.ts';
import { makeProperty, makePerson, futureDate } from './helpers/fixtures.ts';

const TEST_ROLE_FIX = 'issues_rls_test_role_denial_fix';

describe('FIX: recordDenial persists a phase_transition_denied audit row under real RLS', () => {
  let handle: TestDbHandle;

  beforeEach(async () => {
    handle = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb(handle);
  });

  it('a forbidden-role transition denial is audited even though the outer call is never wrapped in a transaction that pre-establishes actor context on auditDb', async () => {
    // Set up the issue as the (superuser/owner) default connection — RLS
    // does not govern this setup step, matching how app/actions.ts's own
    // pre-flight reads/writes for OTHER commands are not this test's
    // concern.
    const property = await makeProperty(handle.db);
    const owner = await makePerson(handle.db);
    const { issue } = await createIssue(handle.db, {
      issueType: 'default_recovery',
      propertyRefId: property.id,
      summary: 'Denial-audit-under-RLS fix verification',
      people: [{ personRefId: owner.id, role: 'owner' }],
      initialTask: { title: 'Initial review', dueDate: futureDate(), queue: 'new_unreviewed' },
    });

    // Now provision and switch to a real non-owner, FORCE-RLS-governed role
    // — mirroring test/rls.test.ts — with grants on exactly the tables the
    // 'forbidden' denial path touches (issues, phase_instances, config_*,
    // audit_events); no possession/hold/vendor-job grants are needed since
    // the role check runs BEFORE any of those reads.
    await handle.client.exec(`create role ${TEST_ROLE_FIX} nosuperuser noinherit login;`);
    await handle.client.exec(
      `grant select, insert, update on issues, phase_instances, config_versions, config_entries, audit_events to ${TEST_ROLE_FIX};`,
    );
    await handle.client.exec(`set role ${TEST_ROLE_FIX};`);

    // Session-level (is_local=false) actor context — NOT the transaction-
    // scoped is_local=true production helper — so the plain, unwrapped
    // reads transitionPhase issues before it ever reaches recordDenial
    // (issue/phase/config selects, each its own implicit one-statement
    // transaction) can see rows under RLS. Deliberately NOT wrapping this
    // whole call in an explicit db.transaction(...): PGlite is a single
    // logical connection with no pool (same limitation documented for the
    // advisory-lock concurrency test in test/service-gaps.test.ts), so a
    // SECOND, nested `.transaction()` on the same handle — which is exactly
    // what recordDenial's fix opens for the audit write — would deadlock
    // against an already-open outer transaction on that one connection. In
    // real (multi-connection) Postgres this nesting is fine (recordDenial's
    // `auditDb.transaction()` acquires its own connection from the pool);
    // this test instead isolates the actual claim under test — that
    // recordDenial's OWN transaction is self-sufficient — by making it the
    // ONLY explicit transaction opened during the call.
    await handle.client.exec(`select set_config('app.actor_id', 'actor-sales', false), set_config('app.roles', 'sales', false)`);

    let thrown: unknown;
    try {
      await transitionPhase(
        handle.db,
        issue.id,
        'legal_vs',
        { roles: ['sales'], actorExternalId: 'actor-sales', actorRole: 'sales' },
        handle.db,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TransitionError);
    expect((thrown as TransitionError).code).toBe('forbidden');

    // The denial audit row must have persisted via recordDenial's own
    // transaction+actor-context (committed on its own, independent of
    // anything the caller pre-established). Read it back through the SAME
    // restricted role, in a fresh explicit transaction of our own, proving
    // the row is really there under RLS — not just "didn't throw".
    const rows = await handle.db.transaction(async (tx) => {
      await pgliteSetActorContext(tx, 'actor-verifier', ['manager']);
      return tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.objectId, issue.id), eq(auditEvents.action, 'phase_transition_denied')));
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.after).toMatchObject({ attemptedPhaseKey: 'legal_vs', denialCode: 'forbidden' });
  });
});
