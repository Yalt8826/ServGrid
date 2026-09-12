import type { Db } from '../devices/repo.js';

/**
 * Notification SQL (PLAN-BACKEND.md §12.1, migration 011). Every query
 * the assignment-push send path needs: the pushable devices of a
 * technician, the stale-token / failure-reason bookkeeping FCM failures
 * demand, and the hold-and-release rows of §15 item 6 (decision B1).
 * This lives beside — not inside — the devices module: the upsert in
 * devices/repo.ts answers the handset's own reports, while these rows
 * are the server's side of the contract.
 */

export interface PushableDevice {
  id: string;
  fcm_token: string;
}

/**
 * The technician's registered devices — one row per install that has
 * ever given us an FCM token, still active. A device WITHOUT a token
 * (registered before the app got one from Firebase) is not pushable and
 * is not a failure: it never promised to be reachable. We deliberately
 * do NOT filter on notifications_enabled — that switch governs whether
 * the client raises the LOCAL notification (PLAN-FRONTEND.md §6's amber
 * chip); the data-only wake itself is content-free and harmless to
 * deliver.
 */
export async function listPushableDevices(db: Db, employeeId: string): Promise<PushableDevice[]> {
  const r = await db.query<PushableDevice>(
    `SELECT id, fcm_token FROM devices
     WHERE employee_id = $1 AND is_active AND fcm_token IS NOT NULL`,
    [employeeId],
  );
  return r.rows;
}

/**
 * §12.1: an unreachable device is a tracking-health finding. UNREGISTERED
 * (and SENDER_ID_MISMATCH — a token minted for a different Firebase
 * sender is dead to us however alive it looks) clears the token so the
 * next registration replaces it, and records WHY, on the device row,
 * where the health chip's diagnostics live.
 */
export async function recordStaleToken(db: Db, deviceId: string, failureReason: string): Promise<void> {
  await db.query(
    `UPDATE devices SET fcm_token = NULL, failure_reason = $2 WHERE id = $1`,
    [deviceId, failureReason],
  );
}

/** A delivered wake means the token works — any recorded failure is stale history. */
export async function clearFailureReason(db: Db, deviceId: string): Promise<void> {
  await db.query(`UPDATE devices SET failure_reason = NULL WHERE id = $1`, [deviceId]);
}

export interface HeldNotificationInsert {
  employeeId: string;
  jobId: string;
  kind: 'assigned' | 'reassigned' | 'cancelled' | 'priority_escalated';
  priority: 'low' | 'normal' | 'high' | 'urgent';
}

/** One held wake — held ≠ dropped (§15 item 6, decision B1). */
export async function insertHeldNotification(db: Db, h: HeldNotificationInsert): Promise<void> {
  await db.query(
    `INSERT INTO held_notifications (employee_id, job_card_id, trigger_kind, priority)
     VALUES ($1::uuid, $2::uuid, $3, $4::job_priority)`,
    [h.employeeId, h.jobId, h.kind, h.priority],
  );
}

export interface HeldNotificationRow {
  id: string;
  employee_id: string;
}

/**
 * Every wake still waiting for the window to open. The release batch is
 * single-instance (§12: one API instance), so a plain read is enough —
 * the rows are marked released before any send is attempted, so a crash
 * mid-release loses at most the morning's wake, which §12.1 prices in
 * (push is never the transport).
 */
export async function listUnreleased(db: Db): Promise<HeldNotificationRow[]> {
  const r = await db.query<HeldNotificationRow>(
    `SELECT id, employee_id FROM held_notifications
     WHERE released_at IS NULL ORDER BY held_at`,
  );
  return r.rows;
}

/** Mark every still-unreleased row released — the batch has discharged them. */
export async function markAllReleased(db: Db, releasedAt: Date): Promise<number> {
  const r = await db.query<{ count: string }>(
    `WITH released AS (
       UPDATE held_notifications SET released_at = $1 WHERE released_at IS NULL
       RETURNING 1
     )
     SELECT count(*) FROM released`,
    [releasedAt.toISOString()],
  );
  return Number(r.rows[0]?.count ?? 0);
}

/** Count of a batch's outcomes, for the structured log line. */
export interface ReleaseSummaryRow {
  rowsReleased: number;
  employees: number;
}
