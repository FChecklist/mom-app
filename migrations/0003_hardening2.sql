-- 0003: review round 1 fixes.
--  * share links: expiry + revoke   * invites instead of pre-created user rows (no squatting)
--  * per-IP rate limits             * idempotency keys for writes
--  * audit log (sign-in, billing, roles, denied access)   * events are append-only (enforced by triggers)
--  * one-time OAuth state           * refund requests       * clean-up indexes

ALTER TABLE shares ADD COLUMN expires_at TEXT;
ALTER TABLE shares ADD COLUMN revoked_at TEXT;
ALTER TABLE shares ADD COLUMN revoked_by TEXT;
CREATE INDEX idx_shares_token ON shares(token_hash);

-- Copied per-point history (from a merge) is shown on the point, not repeated in the MOM-level log.
ALTER TABLE events ADD COLUMN point_only INTEGER NOT NULL DEFAULT 0;

-- A person added to a team by e-mail is an INVITE, not a user row. Only the team owner can create invites.
-- The invite is used when that very address signs in for the first time (they prove the mailbox with a code).
CREATE TABLE invites (
  email TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL DEFAULT '',
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invites_org ON invites(org_id);

-- Fixed-window counters (key is a hash, never a raw IP address).
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  win INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, win)
);

-- A repeated request with the same Idempotency-Key gets the first answer back instead of doing the work twice.
CREATE TABLE idempotency (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fp TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','done')),
  status INTEGER,
  body TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  org_id TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_org ON audit_log(org_id, id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- The MOM history can never be edited or deleted. One narrow exception: once a MOM has been deleted for
-- everyone, the free text of its events may be scrubbed (who/when/type/version stay). Nothing else may change.
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_scrub_only BEFORE UPDATE ON events
WHEN NOT (
  NEW.id IS OLD.id AND NEW.mom_id IS OLD.mom_id AND NEW.point_id IS OLD.point_id AND NEW.at IS OLD.at AND NEW.by IS OLD.by
  AND NEW.type IS OLD.type AND NEW.v IS OLD.v AND NEW.via IS OLD.via AND NEW.to_addr IS OLD.to_addr
  AND NEW.from_addr IS OLD.from_addr AND NEW.share_id IS OLD.share_id AND NEW.point_only IS OLD.point_only
  AND EXISTS (SELECT 1 FROM moms WHERE id = OLD.mom_id AND deleted_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE oauth_states (
  nonce TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','refunded','declined')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_exp ON sessions(expires_at);
CREATE INDEX idx_codes_exp ON auth_codes(expires_at);
CREATE INDEX idx_idem_created ON idempotency(created_at);
