-- Explicit owner approval for group access. Existing authorized chats remain unchanged.
CREATE TABLE IF NOT EXISTS pending_group_approvals (
  chat_id BIGINT PRIMARY KEY,
  chat_type TEXT NOT NULL,
  requested_by BIGINT,
  owner_user_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pending_group_approvals_status
  ON pending_group_approvals(status, requested_at DESC);
