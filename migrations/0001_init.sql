-- MOM v2 schema (Cloudflare D1 / SQLite). Times are ISO-8601 UTC strings.
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  trial_ends_at TEXT NOT NULL,
  plan TEXT,
  plan_until TEXT
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  title TEXT NOT NULL DEFAULT 'Member',
  verified_at TEXT,
  invited_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_users_org ON users(org_id);

CREATE TABLE auth_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_codes_email ON auth_codes(email, scope, created_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','guest')),
  user_id TEXT,
  email TEXT NOT NULL,
  mom_id TEXT,
  share_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE moms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  deleted_by TEXT,
  deleted_at TEXT,
  merged_into TEXT,
  merged_from TEXT
);
CREATE INDEX idx_moms_org ON moms(org_id);

CREATE TABLE mom_attendees (
  mom_id TEXT NOT NULL REFERENCES moms(id),
  email TEXT NOT NULL,
  PRIMARY KEY (mom_id, email)
);

CREATE TABLE points (
  id TEXT PRIMARY KEY,
  mom_id TEXT NOT NULL REFERENCES moms(id),
  no INTEGER NOT NULL,
  title TEXT NOT NULL,
  due TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'WIP' CHECK (status IN ('Complete','WIP','In progress','Discarded')),
  todo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (mom_id, no)
);

CREATE TABLE point_owners (
  point_id TEXT NOT NULL REFERENCES points(id),
  email TEXT NOT NULL,
  PRIMARY KEY (point_id, email)
);
CREATE INDEX idx_point_owners_email ON point_owners(email);

-- One append-only event list per MOM. type: content (makes a numbered version), activity, share, open.
-- point_id + pwhat give each point its own history; the MOM-level list is the public log.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mom_id TEXT NOT NULL REFERENCES moms(id),
  point_id TEXT,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('content','activity','share','open')),
  what TEXT NOT NULL,
  pwhat TEXT,
  v INTEGER,
  detail TEXT,
  via TEXT,
  to_addr TEXT,
  from_addr TEXT
);
CREATE INDEX idx_events_mom ON events(mom_id, id);
CREATE INDEX idx_events_point ON events(point_id, id);

CREATE TABLE point_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id TEXT NOT NULL REFERENCES points(id),
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  mom_id TEXT NOT NULL REFERENCES moms(id),
  point_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text','url','link','pdf','image')),
  name TEXT NOT NULL,
  url TEXT,
  mime TEXT,
  size_bytes INTEGER,
  data TEXT,
  by TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_att_mom ON attachments(mom_id);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  mom_id TEXT NOT NULL REFERENCES moms(id),
  token_hash TEXT NOT NULL UNIQUE,
  via TEXT NOT NULL CHECK (via IN ('email','whatsapp','link')),
  to_addr TEXT,
  by TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  org_id TEXT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  error TEXT
);
CREATE INDEX idx_outbox_at ON outbox(at);

CREATE TABLE integrations (
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  mode TEXT NOT NULL CHECK (mode IN ('mock','live')),
  account TEXT,
  token_enc TEXT,
  connected_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE calendar_events (
  point_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (point_id, user_id, provider)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  plan TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  provider TEXT NOT NULL,
  provider_order_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  payment_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE UNIQUE INDEX idx_orders_provider ON orders(provider, provider_order_id);
