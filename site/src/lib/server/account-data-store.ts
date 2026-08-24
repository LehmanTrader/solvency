import type { D1DatabaseLike } from './pages-types.ts';

const OWNER_ID = /^user_[A-Za-z0-9_-]{3,123}$/;

/** Atomically removes every current D1 record keyed to one verified owner. */
export async function deleteOwnedAccountData(db: D1DatabaseLike, ownerUserId: string): Promise<void> {
  if (!OWNER_ID.test(ownerUserId)) throw new Error('Verified owner ID is invalid.');
  const results = await db.batch([
    db.prepare(`DELETE FROM product_intent_events WHERE owner_user_id = ?`).bind(ownerUserId),
    db.prepare(`DELETE FROM billing_events WHERE owner_user_id = ?`).bind(ownerUserId),
    db.prepare(`DELETE FROM billing_subscriptions WHERE owner_user_id = ?`).bind(ownerUserId),
    db.prepare(`DELETE FROM billing_customers WHERE owner_user_id = ?`).bind(ownerUserId),
    db.prepare(`DELETE FROM build_plan_operation_requests WHERE owner_user_id = ?`).bind(ownerUserId),
    db.prepare(`DELETE FROM build_plan_alert_settings WHERE owner_user_id = ?`).bind(ownerUserId),
    db.prepare(`DELETE FROM build_plan_shares WHERE owner_user_id = ?`).bind(ownerUserId),
    db.prepare(`DELETE FROM build_plans WHERE owner_user_id = ?`).bind(ownerUserId),
    db.prepare(`DELETE FROM build_plan_rate_limits WHERE owner_user_id = ?`).bind(ownerUserId),
  ]);
  if (results.length !== 9 || results.some((result) => result.success !== true)) {
    throw new Error('Account data deletion failed.');
  }
}
