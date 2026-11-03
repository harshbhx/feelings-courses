-- Migration 0003: email identity (owner decision, 23 Oct 2026). A student is identified by their
-- email and signs in with a single-use link sent to it (docs/platform/STUDENTS.md). The phone
-- number stays on students.phone as an optional contact detail only: it never finds an account.
--
-- Additive and idempotent (IF NOT EXISTS), within D1's limits. Old code ignores the new table.
-- Sign-in links reuse login_tokens (purpose 'admin_link' = a link opened with a Continue button):
-- their lifetime is the row's expires_at (15 minutes for emailed links, 24 hours for the admin's).

-- When a student's email was proven: the student opened a sign-in link sent to that address, or
-- one the admin made for them. `email` is the address proven, so a changed address needs a new
-- proof. Until an account's email is proven, a purchase may hand off a session on the paying
-- device only when the account holds nothing else (functions/_lib/claim.ts), and the first proof
-- signs out every earlier session once. Erase deletes the row.
CREATE TABLE IF NOT EXISTS email_verifications (
  student_id  INTEGER PRIMARY KEY REFERENCES students (id) ON DELETE CASCADE,
  email       TEXT    NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  verified_at INTEGER NOT NULL
);

-- "Only the newest link works": issuing a link marks the student's unused older ones used.
CREATE INDEX IF NOT EXISTS login_tokens_student ON login_tokens (student_id, purpose, used_at);
