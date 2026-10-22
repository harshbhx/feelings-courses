-- Migration 0001: the course platform. Cloudflare D1 (SQLite).
-- ids INTEGER PRIMARY KEY. timestamps integer unix seconds UTC (NULL = has not happened).
-- money integer paise. booleans 0 or 1. Business rows are never hard deleted.

-- ---------------------------------------------------------------- settings
-- Key-value JSON. Keys: business (legal name, address, state_code, gstin, sac, gst_rate_bp,
-- prices_include_tax), legal_confirmed, admin_password_hash, content_version, published_version,
-- last_rebuild_at, last_backup_at, last_cleanup_at.
CREATE TABLE settings (
  key        TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 60),
  value      TEXT    NOT NULL CHECK (json_valid(value) AND length(value) <= 20000),
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- courses
CREATE TABLE courses (
  id                INTEGER PRIMARY KEY,
  -- Also the subdomain label (<slug>.feelingsbeautycare.in) and the /c/<slug> path. DNS-safe.
  slug              TEXT    NOT NULL UNIQUE
                    CHECK (length(slug) BETWEEN 2 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'
                           AND slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND instr(slug, '--') = 0),
  title             TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  subtitle          TEXT    CHECK (subtitle IS NULL OR length(subtitle) <= 300),
  description       TEXT    CHECK (description IS NULL OR length(description) <= 20000),
  teacher           TEXT    NOT NULL DEFAULT 'Urmi Mengar' CHECK (length(teacher) BETWEEN 1 AND 80),
  format            TEXT    NOT NULL DEFAULT 'online' CHECK (format IN ('online', 'in_person', 'hybrid')),
  -- NULL only while a draft has no price yet. 0 = free. Else at least Rs 1.
  price_paise       INTEGER CHECK (price_paise IS NULL OR (typeof(price_paise) = 'integer'
                                   AND (price_paise = 0 OR price_paise BETWEEN 100 AND 100000000))),
  compare_at_paise  INTEGER CHECK (compare_at_paise IS NULL OR (typeof(compare_at_paise) = 'integer'
                                   AND price_paise IS NOT NULL AND compare_at_paise > price_paise)),
  -- In-person: optional booking amount paid online, balance at the studio.
  deposit_paise     INTEGER CHECK (deposit_paise IS NULL OR (typeof(deposit_paise) = 'integer'
                                   AND deposit_paise >= 100 AND price_paise IS NOT NULL AND deposit_paise < price_paise)),
  currency          TEXT    NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  level             TEXT    CHECK (level IS NULL OR length(level) <= 60),
  language          TEXT    CHECK (language IS NULL OR length(language) <= 80),
  duration_text     TEXT    CHECK (duration_text IS NULL OR length(duration_text) <= 60),
  access_days       INTEGER CHECK (access_days IS NULL OR (typeof(access_days) = 'integer' AND access_days BETWEEN 1 AND 3650)),
  certificate_title TEXT    CHECK (certificate_title IS NULL OR length(certificate_title) <= 200),
  -- JSON: { outcomes: string[], forWho: string[], faqs: {q,a}[], glimpses: {youtubeId,label}[],
  --         highlights: string[] }. Validated by the API (shared/types.ts CourseDetails).
  details           TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(details) AND length(details) <= 50000),
  cover_key         TEXT    CHECK (cover_key IS NULL OR length(cover_key) <= 300),
  og_image_key      TEXT    CHECK (og_image_key IS NULL OR length(og_image_key) <= 300),
  seo_title         TEXT    CHECK (seo_title IS NULL OR length(seo_title) <= 70),
  seo_description   TEXT    CHECK (seo_description IS NULL OR length(seo_description) <= 170),
  -- 1: example content (seed). Ribbon, noindex, and live payments refused.
  is_demo           INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  status            TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  domain_status     TEXT    NOT NULL DEFAULT 'none' CHECK (domain_status IN ('none', 'pending', 'active')),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  published_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  CHECK (status <> 'published' OR (published_at IS NOT NULL AND price_paise IS NOT NULL))
);
CREATE INDEX courses_status ON courses (status, deleted_at, sort_order);

-- ---------------------------------------------------------------- batches (in-person / hybrid)
CREATE TABLE batches (
  id            INTEGER PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES courses (id),
  title         TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  starts_on     TEXT    NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ends_on       TEXT    CHECK (ends_on IS NULL OR ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  schedule_text TEXT    CHECK (schedule_text IS NULL OR length(schedule_text) <= 300),
  -- NULL: the course price applies.
  price_paise   INTEGER CHECK (price_paise IS NULL OR (typeof(price_paise) = 'integer' AND price_paise BETWEEN 100 AND 100000000)),
  seats         INTEGER CHECK (seats IS NULL OR (typeof(seats) = 'integer' AND seats >= 1)),
  seats_taken   INTEGER NOT NULL DEFAULT 0 CHECK (seats_taken >= 0),
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX batches_course ON batches (course_id, status, starts_on);

-- ---------------------------------------------------------------- modules and lessons
CREATE TABLE modules (
  id         INTEGER PRIMARY KEY,
  course_id  INTEGER NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position <> 0),
  title      TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (course_id, position),
  UNIQUE (id, course_id)
);

CREATE TABLE lessons (
  id               INTEGER PRIMARY KEY,
  course_id        INTEGER NOT NULL,
  module_id        INTEGER NOT NULL,
  position         INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position <> 0),
  slug             TEXT    NOT NULL CHECK (length(slug) BETWEEN 1 AND 80 AND slug NOT GLOB '*[^a-z0-9-]*'
                                           AND slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND instr(slug, '--') = 0
                                           AND slug NOT IN ('certificate', 'logout', 'index')),
  title            TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  minutes          INTEGER NOT NULL DEFAULT 0 CHECK (typeof(minutes) = 'integer' AND minutes BETWEEN 0 AND 600),
  -- r2: video_ref is the R2 key. youtube: a video id (kept for glimpse-style public clips). stream: future.
  video_provider   TEXT    NOT NULL DEFAULT 'none' CHECK (video_provider IN ('r2', 'youtube', 'stream', 'none')),
  video_ref        TEXT    CHECK (video_ref IS NULL OR length(video_ref) BETWEEN 1 AND 300),
  vertical         INTEGER NOT NULL DEFAULT 0 CHECK (vertical IN (0, 1)),
  captions_key     TEXT    CHECK (captions_key IS NULL OR length(captions_key) <= 300),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  notes            TEXT    CHECK (notes IS NULL OR length(notes) <= 20000),
  free_preview     INTEGER NOT NULL DEFAULT 0 CHECK (free_preview IN (0, 1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (module_id, course_id) REFERENCES modules (id, course_id) ON DELETE CASCADE,
  UNIQUE (module_id, position),
  UNIQUE (course_id, slug),
  CHECK ((video_provider = 'none') = (video_ref IS NULL))
);
CREATE INDEX lessons_course ON lessons (course_id);

-- ---------------------------------------------------------------- media (uploads registry)
CREATE TABLE media (
  id          INTEGER PRIMARY KEY,
  key         TEXT    NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 300),
  kind        TEXT    NOT NULL CHECK (kind IN ('video', 'image', 'captions', 'file')),
  content_type TEXT   NOT NULL CHECK (length(content_type) BETWEEN 3 AND 100),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
  original_name TEXT  CHECK (original_name IS NULL OR length(original_name) <= 200),
  upload_id   TEXT    CHECK (upload_id IS NULL OR length(upload_id) <= 1000),
  status      TEXT    NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready', 'aborted', 'deleted')),
  lesson_id   INTEGER REFERENCES lessons (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX media_status ON media (status, created_at);

-- ---------------------------------------------------------------- students
CREATE TABLE students (
  id         INTEGER PRIMARY KEY,
  name       TEXT    CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80),
  phone      TEXT    UNIQUE CHECK (phone IS NULL OR (phone GLOB '+[1-9]*' AND substr(phone, 2) NOT GLOB '*[^0-9]*'
                                                    AND length(phone) BETWEEN 9 AND 16)),
  email      TEXT    UNIQUE CHECK (email IS NULL OR (length(email) BETWEEN 3 AND 254 AND email = lower(email)
                                                    AND email LIKE '%_@_%' AND instr(email, ' ') = 0)),
  state_code TEXT    CHECK (state_code IS NULL OR state_code GLOB '[0-9][0-9]'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- DPDP erase: name, phone, email nulled, erased_at set. Orders keep amounts for tax.
  erased_at  INTEGER,
  CHECK (erased_at IS NOT NULL OR phone IS NOT NULL OR email IS NOT NULL)
);

-- ---------------------------------------------------------------- coupons
CREATE TABLE coupons (
  id               INTEGER PRIMARY KEY,
  code             TEXT    NOT NULL UNIQUE CHECK (length(code) BETWEEN 3 AND 32 AND code = upper(code)
                                                  AND code NOT GLOB '*[^A-Z0-9_-]*'),
  percent_off      INTEGER CHECK (percent_off IS NULL OR (typeof(percent_off) = 'integer' AND percent_off BETWEEN 1 AND 100)),
  amount_off_paise INTEGER CHECK (amount_off_paise IS NULL OR (typeof(amount_off_paise) = 'integer'
                                                               AND amount_off_paise BETWEEN 100 AND 100000000)),
  course_id        INTEGER REFERENCES courses (id),
  max_uses         INTEGER CHECK (max_uses IS NULL OR (typeof(max_uses) = 'integer' AND max_uses >= 1)),
  used_count       INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  starts_at        INTEGER,
  expires_at       INTEGER,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  allow_free       INTEGER NOT NULL DEFAULT 0 CHECK (allow_free IN (0, 1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((percent_off IS NULL) <> (amount_off_paise IS NULL)),
  CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX coupons_course ON coupons (course_id) WHERE course_id IS NOT NULL;

-- ---------------------------------------------------------------- orders
-- created -> paid -> (partially_refunded) -> refunded, or created -> failed -> paid.
CREATE TABLE orders (
  id                  INTEGER PRIMARY KEY,
  razorpay_order_id   TEXT    UNIQUE CHECK (razorpay_order_id IS NULL OR (length(razorpay_order_id) <= 64
                                            AND razorpay_order_id NOT GLOB '*[^A-Za-z0-9_]*')),
  mode                TEXT    NOT NULL CHECK (mode IN ('test', 'live')),
  student_id          INTEGER NOT NULL REFERENCES students (id),
  course_id           INTEGER NOT NULL REFERENCES courses (id),
  batch_id            INTEGER REFERENCES batches (id),
  payment_kind        TEXT    NOT NULL DEFAULT 'full' CHECK (payment_kind IN ('full', 'deposit')),
  list_price_paise    INTEGER NOT NULL CHECK (typeof(list_price_paise) = 'integer' AND list_price_paise >= 0),
  discount_paise      INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount_paise) = 'integer' AND discount_paise >= 0),
  amount_paise        INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise BETWEEN 100 AND 100000000),
  currency            TEXT    NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  coupon_id           INTEGER REFERENCES coupons (id),
  buyer_state_code    TEXT    CHECK (buyer_state_code IS NULL OR buyer_state_code GLOB '[0-9][0-9]'),
  status              TEXT    NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created', 'paid', 'failed', 'partially_refunded', 'refunded')),
  razorpay_payment_id TEXT    UNIQUE CHECK (razorpay_payment_id IS NULL OR (length(razorpay_payment_id) <= 64
                                              AND razorpay_payment_id NOT GLOB '*[^A-Za-z0-9_]*')),
  method              TEXT    CHECK (method IS NULL OR length(method) <= 30),
  -- What the buyer typed in Razorpay's form (may differ from our form). Used by restore.
  payer_contact       TEXT    CHECK (payer_contact IS NULL OR length(payer_contact) <= 20),
  payer_email         TEXT    CHECK (payer_email IS NULL OR length(payer_email) <= 254),
  -- GST-ready. Snapshot of the tax split at payment time (0 when no GSTIN).
  invoice_no          TEXT    UNIQUE CHECK (invoice_no IS NULL OR length(invoice_no) <= 40),
  taxable_paise       INTEGER CHECK (taxable_paise IS NULL OR taxable_paise >= 0),
  cgst_paise          INTEGER NOT NULL DEFAULT 0,
  sgst_paise          INTEGER NOT NULL DEFAULT 0,
  igst_paise          INTEGER NOT NULL DEFAULT 0,
  refunded_paise      INTEGER NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  failure_reason      TEXT    CHECK (failure_reason IS NULL OR length(failure_reason) <= 300),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  paid_at             INTEGER,
  failed_at           INTEGER,
  CHECK (coupon_id IS NOT NULL OR discount_paise = 0),
  CHECK (status IN ('created', 'failed') OR (razorpay_payment_id IS NOT NULL AND paid_at IS NOT NULL)),
  CHECK (refunded_paise <= amount_paise)
);
CREATE INDEX orders_student ON orders (student_id, created_at);
CREATE INDEX orders_course ON orders (course_id, created_at);
CREATE INDEX orders_status_paid_at ON orders (status, paid_at);
CREATE INDEX orders_coupon ON orders (coupon_id) WHERE coupon_id IS NOT NULL;

-- ---------------------------------------------------------------- refunds
CREATE TABLE refunds (
  id                 INTEGER PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES orders (id),
  razorpay_refund_id TEXT    UNIQUE CHECK (razorpay_refund_id IS NULL OR length(razorpay_refund_id) <= 64),
  amount_paise       INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise >= 100),
  status             TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  reason             TEXT    CHECK (reason IS NULL OR length(reason) <= 300),
  revoke_access      INTEGER NOT NULL DEFAULT 1 CHECK (revoke_access IN (0, 1)),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX refunds_order ON refunds (order_id);

-- ---------------------------------------------------------------- invoice numbers
-- One row per financial year ('2026-27'). Incremented inside the fulfil batch.
CREATE TABLE invoice_counters (
  fy   TEXT    PRIMARY KEY CHECK (fy GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  last INTEGER NOT NULL DEFAULT 0 CHECK (last >= 0)
);

-- ---------------------------------------------------------------- enrollments
CREATE TABLE enrollments (
  id           INTEGER PRIMARY KEY,
  student_id   INTEGER NOT NULL REFERENCES students (id),
  course_id    INTEGER NOT NULL REFERENCES courses (id),
  batch_id     INTEGER REFERENCES batches (id),
  source       TEXT    NOT NULL CHECK (source IN ('payment', 'manual', 'coupon_free')),
  mode         TEXT    NOT NULL CHECK (mode IN ('test', 'live')),
  order_id     INTEGER REFERENCES orders (id),
  starts_at    INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (student_id, course_id),
  CHECK (source <> 'payment' OR order_id IS NOT NULL),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX enrollments_course ON enrollments (course_id, created_at);
CREATE INDEX enrollments_order ON enrollments (order_id) WHERE order_id IS NOT NULL;

-- ---------------------------------------------------------------- coupon redemptions
CREATE TABLE coupon_redemptions (
  id             INTEGER PRIMARY KEY,
  coupon_id      INTEGER NOT NULL REFERENCES coupons (id),
  student_id     INTEGER NOT NULL REFERENCES students (id),
  course_id      INTEGER NOT NULL REFERENCES courses (id),
  order_id       INTEGER UNIQUE REFERENCES orders (id),
  discount_paise INTEGER NOT NULL CHECK (discount_paise >= 0),
  created_at     INTEGER NOT NULL
);
CREATE INDEX coupon_redemptions_coupon ON coupon_redemptions (coupon_id, created_at);
CREATE UNIQUE INDEX coupon_redemptions_free_once
  ON coupon_redemptions (coupon_id, student_id, course_id) WHERE order_id IS NULL;

-- ---------------------------------------------------------------- progress
CREATE TABLE lesson_progress (
  student_id       INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  lesson_id        INTEGER NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  completed_at     INTEGER,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (student_id, lesson_id)
);
CREATE INDEX lesson_progress_lesson ON lesson_progress (lesson_id);

-- ---------------------------------------------------------------- certificates
CREATE TABLE certificates (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL UNIQUE CHECK (length(code) = 10 AND code NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  student_id    INTEGER NOT NULL REFERENCES students (id),
  course_id     INTEGER NOT NULL REFERENCES courses (id),
  name_on_cert  TEXT    NOT NULL CHECK (length(name_on_cert) BETWEEN 2 AND 80),
  title         TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  issued_at     INTEGER NOT NULL,
  revoked_at    INTEGER,
  UNIQUE (student_id, course_id)
);

-- ---------------------------------------------------------------- sign-in
CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT    NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  student_id   INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  user_agent   TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_student ON sessions (student_id, revoked_at, created_at);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Single-use tokens: 'handoff' (course host -> hub after payment, 10 min) and
-- 'admin_link' (access link Urmi sends on WhatsApp, 24 h).
CREATE TABLE login_tokens (
  id            INTEGER PRIMARY KEY,
  token_hash    TEXT    NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  purpose       TEXT    NOT NULL CHECK (purpose IN ('handoff', 'admin_link')),
  student_id    INTEGER NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  redirect_path TEXT    NOT NULL CHECK (redirect_path GLOB '/*' AND redirect_path NOT GLOB '//*'),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX login_tokens_expires ON login_tokens (expires_at);

CREATE TABLE admin_sessions (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT    NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  ip           TEXT,
  user_agent   TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 400)
);

-- ---------------------------------------------------------------- webhooks
CREATE TABLE webhook_events (
  event_id     TEXT    PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 100),
  type         TEXT    NOT NULL CHECK (length(type) <= 60),
  mode         TEXT    NOT NULL CHECK (mode IN ('test', 'live')),
  payload      TEXT    NOT NULL CHECK (json_valid(payload) AND length(payload) <= 100000),
  received_at  INTEGER NOT NULL,
  processed_at INTEGER,
  error        TEXT    CHECK (error IS NULL OR length(error) <= 1000)
);
CREATE INDEX webhook_events_pending ON webhook_events (processed_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------- rate limits
CREATE TABLE rate_limits (
  bucket     TEXT    PRIMARY KEY CHECK (length(bucket) <= 200),
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expires ON rate_limits (expires_at);

-- ---------------------------------------------------------------- analytics
-- course_id 0 = hub pages.
CREATE TABLE daily_stats (
  day               TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  course_id         INTEGER NOT NULL,
  views             INTEGER NOT NULL DEFAULT 0,
  checkouts_started INTEGER NOT NULL DEFAULT 0,
  paid_orders       INTEGER NOT NULL DEFAULT 0,
  revenue_paise     INTEGER NOT NULL DEFAULT 0,
  refunds_paise     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, course_id)
);

-- ---------------------------------------------------------------- audit log (from the recovered schema)
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  actor      TEXT    NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  action     TEXT    NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  entity     TEXT    NOT NULL CHECK (length(entity) BETWEEN 1 AND 40),
  entity_id  TEXT    CHECK (entity_id IS NULL OR length(entity_id) <= 80),
  data       TEXT    CHECK (data IS NULL OR (json_valid(data) AND length(data) <= 16000)),
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_entity ON audit_log (entity, entity_id, created_at);
CREATE INDEX audit_log_created ON audit_log (created_at);
