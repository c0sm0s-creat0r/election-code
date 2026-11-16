export type AuditEntry = {
  /**
   * Null only for an action with no batch (a denied super-admin-key attempt).
   * Otherwise an id loaded from the database: audit_log has no foreign key.
   */
  batchId: string | null
  /** `public` is an unauthenticated caller: a society signing up. */
  role: 'super' | 'public' | 'officer' | 'door' | 'voter'
  action: string
  detail?: AuditDetail
}

/**
 * What an audit row may record. An allow-list: audit_log has no foreign key
 * to `batch` and outlives the roll purge and the society, so it holds nothing
 * personal. An id here would also rebuild, through AUTOINCREMENT and `at`,
 * the voter-to-ballot link the `ballot` table prevents.
 *
 * No usu_id, no ballot id, no preference list. Counts and reasons only. A new
 * audited action needs a new variant here.
 */
export type AuditDetail =
  | { kind: 'roll_import'; total: number; eligible: number; excluded: number; skipped: number }
  | { kind: 'roll_purge'; rowsDeleted: number }
  | { kind: 'election_open'; seats: number; candidates: number }
  | { kind: 'election_close'; ballotCount: number }
  | { kind: 'count'; rounds: number; winners: number }
  | { kind: 'tie_override'; tieBreakId: string; reason: string }
  // Counts only. No slug or society name: the row outlives the society.
  | { kind: 'election_delete'; status: 'draft' | 'open' | 'closed' }
  | { kind: 'batch_delete'; elections: number; ballots: number; voters: number }

/** Builds the audit insert without running it, for use in a `db.batch`. */
export function auditLogStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (batch_id, role, action, detail, at) VALUES (?,?,?,?,?)`)
    .bind(entry.batchId, entry.role, entry.action, entry.detail === undefined ? null : JSON.stringify(entry.detail), Date.now())
}

export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditLogStatement(db, entry).run()
}
