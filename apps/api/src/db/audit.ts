export type AuditEntry = {
  batchId: string
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
