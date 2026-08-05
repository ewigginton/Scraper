/**
 * saved-view-service.ts — create/delete/list saved /issues views (spec §15),
 * scoped to their owner. Writes go through saved-views-repo and are audited
 * via lib/services/audit.ts in the SAME transaction as every other command
 * in this package (spec §29.2). Callers are expected to run createSavedView/
 * deleteSavedView inside db.transaction(...) with setActorContext already
 * applied (see lib/db/actor-context.ts) — the owner-scoped RLS policy on
 * saved_views (20260804100000_issues_scale_indexes_search_views.sql)
 * additionally enforces the same ownership this service checks in
 * application code (defense in depth, DESIGN.md §7/§23).
 */

import * as savedViewsRepo from '../repositories/saved-views-repo.ts';
import type { DbHandle } from '../repositories/db-handle.ts';
import type { SavedView } from '../db/schema.ts';
import { writeAudit } from './audit.ts';

export class SavedViewServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SavedViewServiceError';
    this.code = code;
  }
}

const MAX_NAME_LENGTH = 80;

/** Non-empty, <= 80 char name; a plain (non-array, non-null) params object — spec §15. */
function validateInput(name: unknown, params: unknown): { name: string; params: Record<string, unknown> } {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName.length === 0) {
    throw new SavedViewServiceError('name_required', 'A saved view requires a name.');
  }
  if (trimmedName.length > MAX_NAME_LENGTH) {
    throw new SavedViewServiceError('name_too_long', `A saved view name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new SavedViewServiceError('params_invalid', 'Saved view params must be a plain object.');
  }
  return { name: trimmedName, params: params as Record<string, unknown> };
}

export interface CreateSavedViewInput {
  ownerExternalId: string;
  name: string;
  params: unknown;
  actorId?: string | null;
  actorExternalId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/** Create a saved view for its owner. Throws SavedViewServiceError on invalid input or a duplicate name for that owner. */
export async function createSavedView(tx: DbHandle, input: CreateSavedViewInput): Promise<SavedView> {
  if (!input.ownerExternalId) {
    throw new SavedViewServiceError('owner_required', 'A saved view requires an owner.');
  }
  const { name, params } = validateInput(input.name, input.params);

  const existing = await savedViewsRepo.findByOwnerAndName(tx, input.ownerExternalId, name);
  if (existing) {
    throw new SavedViewServiceError('duplicate_name', `A saved view named "${name}" already exists.`);
  }

  const view = await savedViewsRepo.create(tx, {
    ownerExternalId: input.ownerExternalId,
    name,
    params,
  });

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? input.ownerExternalId,
    actorRole: input.actorRole ?? null,
    action: 'saved_view_created',
    objectTable: 'saved_views',
    objectId: view.id,
    before: null,
    after: view,
    correlationId: input.correlationId ?? null,
    source: 'saved-view-service.createSavedView',
  });

  return view;
}

export interface DeleteSavedViewInput {
  ownerExternalId: string;
  id: string;
  actorId?: string | null;
  actorExternalId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
}

/** Delete an owner's own saved view. Throws SavedViewServiceError if no such saved view exists for that owner. */
export async function deleteSavedView(tx: DbHandle, input: DeleteSavedViewInput): Promise<SavedView> {
  const existing = await savedViewsRepo.getForOwner(tx, input.ownerExternalId, input.id);
  if (!existing) {
    throw new SavedViewServiceError('saved_view_not_found', `Saved view ${input.id} not found for this owner.`);
  }

  const removed = await savedViewsRepo.remove(tx, input.ownerExternalId, input.id);
  if (!removed) {
    throw new SavedViewServiceError('saved_view_not_found', `Saved view ${input.id} not found for this owner.`);
  }

  await writeAudit(tx, {
    actorId: input.actorId ?? null,
    actorExternalId: input.actorExternalId ?? input.ownerExternalId,
    actorRole: input.actorRole ?? null,
    action: 'saved_view_deleted',
    objectTable: 'saved_views',
    objectId: removed.id,
    before: removed,
    after: null,
    correlationId: input.correlationId ?? null,
    source: 'saved-view-service.deleteSavedView',
  });

  return removed;
}

/** List an owner's saved views. Read-only; not audited (matches config-repo.get and every other plain read in this package). */
export async function listSavedViews(db: DbHandle, ownerExternalId: string): Promise<SavedView[]> {
  return savedViewsRepo.listForOwner(db, ownerExternalId);
}
