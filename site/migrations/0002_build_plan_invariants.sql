-- Bound account-owned storage independently of browser controls. D1 executes
-- writes serially, so this trigger enforces the cap at the database boundary.
CREATE TRIGGER build_plans_owner_quota
BEFORE INSERT ON build_plans
WHEN (SELECT COUNT(*) FROM build_plans WHERE owner_user_id = NEW.owner_user_id) >= 20
BEGIN
  SELECT RAISE(ABORT, 'OWNER_PLAN_LIMIT');
END;

-- A direct child delete would strand the parent's current_version and any
-- idempotency record for that version. Permit only the parent FK cascade: the
-- parent row is already absent when SQLite executes the child delete trigger.
CREATE TRIGGER build_plan_versions_no_delete
BEFORE DELETE ON build_plan_versions
WHEN EXISTS (SELECT 1 FROM build_plans WHERE id = OLD.plan_id)
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_VERSION');
END;
