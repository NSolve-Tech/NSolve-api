CREATE TABLE admin_password_reset_logs (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX admin_password_reset_logs_target
  ON admin_password_reset_logs(school_id, target_user_id, reset_at DESC);
