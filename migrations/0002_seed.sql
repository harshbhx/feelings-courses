-- Migration 0002: the seed. What the platform starts with on a fresh database.
--
-- 1. DEMO: the Self Makeup Masterclass (courses.is_demo = 1), copied from src/data/course.ts
--    (title, texts, price, modules, lessons, minutes, FAQs, glimpses) and src/data/lessons.ts
--    (lesson slugs, the /learn URLs). EVERY value is example content that the client has not
--    confirmed (course.toConfirm). is_demo = 1 shows the demo ribbon, keeps the page noindexed and
--    refuses live payments. Edit it in the admin once confirmed, never here.
--    tests/db/seed.test.mjs checks that this seed still matches course.ts and lessons.ts.
-- 2. The academy's three courses as DRAFTS with no price (price_paise NULL, so they can't be
--    published until the owner enters a fee). format 'hybrid': in-person batch booking AND recorded
--    lessons, the owner's answer (plan 10.2), changeable per course in the admin. access_days 365
--    (plan 10.6). Outlines are the main site's `covers` lists, from
--    feelings-beauty-care/src/data/services.ts (makeup-academy-jamnagar), 2026-10-23.
-- 3. settings: business facts from src/data/site.ts, legal_confirmed false, content_version 1.
--    No GSTIN and no tax fields: the owner does not want tax shown anywhere (plan 10.5).
--
-- SLUGS ARE PROVISIONAL. The owner picks each course's subdomain in the admin (plan 10.1): every
-- slug below can be renamed there until its domain is active. No code depends on these values.
--
-- Ids are fixed, so the build's seed snapshot (src/data/snapshot.ts) and this seed agree.
-- No lesson has a video yet (video_provider 'none') and none is a free preview.
-- Comments here avoid semicolons: wrangler splits the file on them.
-- Row lists are VALUES, never chains of UNION ALL SELECT: D1 allows at most 5 terms in a compound
-- SELECT (D1 error: too many terms in compound SELECT), and a VALUES list is not limited.

-- ---------------------------------------------------------------- 1. DEMO course

INSERT INTO courses (
  id, slug, title, subtitle, description, teacher, format,
  price_paise, compare_at_paise, deposit_paise, currency, level, language, duration_text, access_days,
  certificate_title, details, is_demo, status, domain_status, sort_order,
  published_at, created_at, updated_at
) VALUES (
  1, 'selfmakeup', 'Self Makeup Masterclass',
  'Learn the makeup Urmi does for brides, on your own face, in short video lessons.',
  NULL, 'Urmi Mengar', 'online',
  299900, NULL, NULL, 'INR', 'Beginner to confident', 'Hindi and Gujarati, with English terms', NULL, 365,
  'Certificate of completion from Feelings Beauty Care',
  json('{
    "outcomes": [
      "Prep skin so makeup lasts through a long function",
      "Match foundation and concealer to Indian skin tones",
      "Do a soft glam and a party look in under 30 minutes",
      "Blend eyeshadow, line eyes and fix lashes cleanly",
      "Choose products that suit your budget"
    ],
    "forWho": [
      "Brides-to-be who want to do their own pre-wedding function looks",
      "Women who want everyday makeup that looks like them",
      "Beginners thinking about makeup as a career, before a full academy course"
    ],
    "faqs": [
      { "q": "Do I need any makeup experience?", "a": "No. The course starts from skin prep and builds up one step at a time." },
      { "q": "Which products do I need?", "a": "A short starter list comes with the first lesson. You can use what you already have." },
      { "q": "How long can I watch the lessons?", "a": "You get access for the period shown on this page, on phone or laptop." },
      { "q": "Is there a certificate?", "a": "Yes, after you finish the lessons." },
      { "q": "Can I ask Urmi questions?", "a": "Yes, on WhatsApp. The button is at the bottom of this page." }
    ],
    "glimpses": [
      { "youtubeId": "X6w8f8d0ON4", "label": "Certification day at the academy" },
      { "youtubeId": "vFGCoQrwch4", "label": "Student’s work at the academy" },
      { "youtubeId": "AIXl9I2_X_w", "label": "Dewy makeup look" },
      { "youtubeId": "nXRVnVS0ack", "label": "Royal bridal makeup look" },
      { "youtubeId": "YGNvPE4qvJM", "label": "Reception night glam" }
    ],
    "highlights": []
  }'),
  1, 'published', 'none', 0,
  CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
);

WITH m (id, position, title) AS (VALUES
  (1, 1, 'Skin prep and base'),
  (2, 2, 'Eyes'),
  (3, 3, 'Complete looks')
)
INSERT INTO modules (id, course_id, position, title, created_at, updated_at)
SELECT m.id, 1, m.position, m.title, c.created_at, c.created_at
FROM courses c
JOIN m
WHERE c.id = 1;

WITH l (id, module_id, position, slug, title, minutes) AS (VALUES
  (1, 1, 1, 'know-your-skin-type', 'Know your skin type', 6),
  (2, 1, 2, 'prep-and-priming', 'Prep and priming for long wear', 9),
  (3, 1, 3, 'foundation-shade-matching', 'Foundation shade matching', 11),
  (4, 2, 1, 'brushes-and-blending', 'Brushes and blending basics', 8),
  (5, 2, 2, 'everyday-eyes', 'Everyday eyes in 5 minutes', 7),
  (6, 2, 3, 'party-eyes', 'Party eyes with shimmer', 12),
  (7, 3, 1, 'soft-glam', 'Soft glam for day functions', 14),
  (8, 3, 2, 'evening-party-look', 'Evening party look', 15),
  (9, 3, 3, 'touch-ups', 'Touch-ups that last the night', 6)
)
INSERT INTO lessons (
  id, course_id, module_id, position, slug, title, minutes,
  video_provider, video_ref, vertical, notes, free_preview, created_at, updated_at
)
SELECT l.id, 1, l.module_id, l.position, l.slug, l.title, l.minutes, 'none', NULL, 0, NULL, 0, c.created_at, c.created_at
FROM courses c
JOIN l
WHERE c.id = 1;

-- ---------------------------------------------------------------- 2. academy drafts (no price)

WITH a (id, slug, title, subtitle, duration_text, sort_order) AS (VALUES
  (2, 'diploma', 'Diploma in makeup artistry',
      'The complete course, from skin basics to a full bridal look.', '3 months', 1),
  (3, 'crashcourse', '5-day crash course',
      'A fast, practical week for beginners or self-makeup.', '5 days', 2),
  (4, 'combo', 'Combo course',
      'The diploma, plus nail art and mehndi modules.', '4–5 months', 3)
)
INSERT INTO courses (
  id, slug, title, subtitle, format, price_paise, duration_text, access_days, details,
  is_demo, status, domain_status, sort_order, created_at, updated_at
)
SELECT a.id, a.slug, a.title, a.subtitle, 'hybrid', NULL, a.duration_text, 365,
       json('{"outcomes":[],"forWho":[],"faqs":[],"glimpses":[],"highlights":[]}'),
       0, 'draft', 'none', a.sort_order,
       CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
FROM a;

INSERT INTO modules (id, course_id, position, title, created_at, updated_at)
SELECT c.id + 2, c.id, 1, 'What you''ll learn', c.created_at, c.created_at
FROM courses c
WHERE c.id IN (2, 3, 4);

WITH l (id, course_id, position, slug, title) AS (VALUES
  (10, 2, 1, 'skin-types-and-colour-theory', 'Skin types and colour theory'),
  (11, 2, 2, 'tools-and-brushes', 'Tools and brushes'),
  (12, 2, 3, 'everyday-and-party-makeup', 'Everyday and party makeup'),
  (13, 2, 4, 'traditional-and-modern-bridal-looks', 'Traditional and modern bridal looks'),
  (14, 2, 5, 'contouring-and-highlighting', 'Contouring and highlighting'),
  (15, 2, 6, 'airbrush-basics', 'Airbrush basics'),
  (16, 2, 7, 'portfolio-shoot', 'Portfolio shoot'),
  (17, 3, 1, 'day-1-skin-prep-and-base', 'Day 1: skin prep and base'),
  (18, 3, 2, 'day-2-eye-makeup', 'Day 2: eye makeup, natural to dramatic'),
  (19, 3, 3, 'day-3-lips-and-contour', 'Day 3: lips and contour'),
  (20, 3, 4, 'day-4-complete-bridal-look', 'Day 4: a complete bridal look'),
  (21, 3, 5, 'day-5-portfolio-shoot-and-review', 'Day 5: portfolio shoot and review'),
  (22, 4, 1, 'the-full-diploma', 'The full diploma'),
  (23, 4, 2, 'nail-art-module', 'Nail art module'),
  (24, 4, 3, 'mehndi-basics-module', 'Mehndi basics module'),
  (25, 4, 4, 'three-certificates', 'Three certificates'),
  (26, 4, 5, 'help-with-starting-work', 'Help with starting work')
)
INSERT INTO lessons (
  id, course_id, module_id, position, slug, title, minutes,
  video_provider, video_ref, vertical, notes, free_preview, created_at, updated_at
)
SELECT l.id, l.course_id, l.course_id + 2, l.position, l.slug, l.title, 0, 'none', NULL, 0, NULL, 0, c.created_at, c.created_at
FROM courses c
JOIN l ON l.course_id = c.id;

-- ---------------------------------------------------------------- 3. settings

INSERT INTO settings (key, value, updated_at) VALUES
  ('business', json('{
    "name": "Feelings Beauty Care",
    "legalName": "Feelings Beauty Care",
    "address": "Om Residency, Hirji Mistry Road, Near J J Tower, Jamnagar, Gujarat 361006",
    "stateCode": "24",
    "gstin": null,
    "phone": "+918000661578",
    "whatsapp": "918000661578"
  }'), CAST(strftime('%s', 'now') AS INTEGER)),
  ('legal_confirmed', 'false', CAST(strftime('%s', 'now') AS INTEGER)),
  ('content_version', '1', CAST(strftime('%s', 'now') AS INTEGER));

-- ---------------------------------------------------------------- audit

INSERT INTO audit_log (actor, action, entity, entity_id, data, created_at)
SELECT 'system', 'course.seed', 'course', CAST(id AS TEXT),
       json_object('migration', '0002_seed', 'demo', json(CASE is_demo WHEN 1 THEN 'true' ELSE 'false' END)),
       created_at
FROM courses
WHERE id IN (1, 2, 3, 4);
