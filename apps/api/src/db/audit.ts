export type AuditEntry = {
  /**
   * null only where the action genuinely has no batch -- a denied
   * super-admin-key attempt on POST /api/batches. Every other caller must
   * pass an id it has already loaded from the database: audit_log has no
   * foreign key, so an unvalidated path parameter would sail straight in.
   */
  batchId: string | null
  /**
   * `public` is an unauthenticated caller — currently only a society signing
   * itself up. 0001's column comment predates it; `role` has no CHECK, so no
   * migration is needed to add one.
   */
  role: 'super' | 'public' | 'officer' | 'door' | 'voter'
  action: string
  detail?: AuditDetail
}

/**
 * What an audit row is allowed to record.
 *
 * This is an allow-list, and deliberately so. `audit_log` is undeletable by
 * construction — spec §2 gives `election_seal` and `election_result` no
 * `ON DELETE CASCADE`, so a sealed election cannot be removed and neither can
 * its batch — while the retention rule purges `voter_roll` and `check_in`
 * after the AGM and claims *that is all the personal data held*.
 *
 * Typing this `unknown` quietly broke two guarantees at once:
 *
 *  - The natural `POST /check-in {usu_id}` handler records the usu_id here,
 *    leaving identifiers in a table the purge cannot reach.
 *  - `audit_log.id` is AUTOINCREMENT and `at` is a timestamp, so a ballot
 *    audit row carrying a ballot id — or a usu_id beside a ballot event —
 *    rebuilds exactly the correlation that `WITHOUT ROWID` and the absent
 *    `ballot.cast_at` exist to prevent. The secret ballot, defeated through
 *    the audit log.
 *
 * So: **never a usu_id, never a ballot id, never a preference list.** Counts
 * and reasons, not identities. Adding a new audited action means adding a
 * variant here, which forces that decision to be made rather than defaulted.
 */
export type AuditDetail =
  | { kind: 'roll_import'; total: number; eligible: number; excluded: number; skipped: number }
  | { kind: 'roll_purge'; rowsDeleted: number }
  | { kind: 'election_open'; seats: number; candidates: number }
  | { kind: 'election_close'; ballotCount: number }
  | { kind: 'count'; rounds: number; winners: number }
  | { kind: 'tie_override'; tieBreakId: string; reason: string }

/**
 * Builds (but does not run) the audit insert. Exposed so callers that need
 * the audit write to be atomic with another statement — e.g. batch creation
 * — can pass both to `db.batch([...])` in one transaction, the same pattern
 * spec §2 uses for the ballot/receipt pair.
 */
export function auditLogStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (batch_id, role, action, detail, at) VALUES (?,?,?,?,?)`)
    .bind(entry.batchId, entry.role, entry.action, entry.detail === undefined ? null : JSON.stringify(entry.detail), Date.now())
}

export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditLogStatement(db, entry).run()
}
