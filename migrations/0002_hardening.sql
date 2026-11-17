-- 0002: sign-up payload on codes, chain pairing of share -> open, lookups used by the API.
ALTER TABLE auth_codes ADD COLUMN payload TEXT;
ALTER TABLE events ADD COLUMN share_id TEXT;
CREATE INDEX idx_events_share ON events(share_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_shares_mom ON shares(mom_id);
CREATE INDEX idx_orders_org ON orders(org_id);
CREATE INDEX idx_updates_point ON point_updates(point_id, id);
