export type AuditEntry = {
  batchId: string
  role: 'super' | 'officer' | 'door'
  action: string
  detail?: unknown
}

/** Every privileged action leaves a row. Spec §6. */
export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(`INSERT INTO audit_log (batch_id, role, action, detail, at) VALUES (?,?,?,?,?)`)
    .bind(entry.batchId, entry.role, entry.action, entry.detail === undefined ? null : JSON.stringify(entry.detail), Date.now())
    .run()
}
