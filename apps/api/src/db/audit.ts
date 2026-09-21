export type AuditEntry = {
  /**
   * null only where the action genuinely has no batch -- a denied
   * super-admin-key attempt on POST /api/batches. Every other caller must
   * pass an id it has already loaded from the database: audit_log has no
   * foreign key, so an unvalidated path parameter would sail straight in.
   */
  batchId: string | null
  role: 'super' | 'officer' | 'door' | 'voter'
  action: string
  detail?: unknown
}

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

/** Every privileged action leaves a row. Spec §6. */
export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditLogStatement(db, entry).run()
}
