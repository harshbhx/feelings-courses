// What the e2e server starts with, on top of the real migrations (schema + seed). Ids are fixed, so
// the build (which fetches this server's /api/public/snapshot) and a fresh server agree.
//
//   glow    recorded course (online), two R2 lessons, certificate, own subdomain (active)
//   studio  in-person course with batches: "Last seat" has 1 seat, "Weekend" has 10; a booking
//           amount (deposit) is paid online
//   coupons WELCOME10 (10% off glow), GIFTGLOW (100% off glow, free enrollment allowed)
//
// No real keys: every secret here is made up for the e2e run.
import { createHmac } from "node:crypto";

export const HUB_HOST = "courses.feelingsbeautycare.in";
export const HUB = `https://${HUB_HOST}`;
export const COURSE_HOST = "https://glow.feelingsbeautycare.in";
export const STUDIO_HOST = "https://studio.feelingsbeautycare.in";
export const ADMIN_PASSWORD = "E2E-Admin-Password-2026-long";

export const SECRETS = Object.freeze({
  RAZORPAY_KEY_ID: "rzp_live_FakeE2E000000001",
  RAZORPAY_KEY_SECRET: "fake_e2e_razorpay_key_secret_only",
  RAZORPAY_WEBHOOK_SECRET: "fake_e2e_razorpay_webhook_secret",
  APP_SECRET: "fake_e2e_app_secret_0123456789abcdef0123",
  DEPLOY_HOOK_URL: "https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/fake-e2e-hook",
});

export const adminPasswordHash = () => createHmac("sha256", SECRETS.APP_SECRET).update(ADMIN_PASSWORD).digest("hex");

/** A tiny MP4 header: enough bytes for range requests (the browser never decodes it). */
export const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 1, 2, 3, 4]);
export const VIDEO_KEYS = ["videos/2026/10/0123456789abcdef-skin-prep.mp4", "videos/2026/10/fedcba9876543210-base.mp4"];

/** SQL run once after the migrations. `past` is 30 days before the server started. */
export function seedSql(past) {
  return `
    INSERT INTO courses (id, slug, title, subtitle, format, price_paise, access_days, certificate_title, status, domain_status, published_at, sort_order, created_at, updated_at)
    VALUES (40, 'glow', 'Glow Makeup', 'Everyday glow makeup in short video lessons.', 'online', 149900, 365, 'Glow Makeup certificate', 'published', 'active', ${past}, 1, ${past}, ${past});
    INSERT INTO modules (id, course_id, position, title, created_at, updated_at) VALUES (400, 40, 1, 'Base', ${past}, ${past});
    INSERT INTO lessons (id, course_id, module_id, position, slug, title, minutes, video_provider, video_ref, duration_seconds, created_at, updated_at)
    VALUES
      (4001, 40, 400, 1, 'prep', 'Skin prep', 6, 'r2', '${VIDEO_KEYS[0]}', 360, ${past}, ${past}),
      (4002, 40, 400, 2, 'base', 'Base and concealer', 8, 'r2', '${VIDEO_KEYS[1]}', 480, ${past}, ${past});

    INSERT INTO courses (id, slug, title, subtitle, format, price_paise, deposit_paise, access_days, status, domain_status, published_at, sort_order, created_at, updated_at)
    VALUES (41, 'studio', 'Studio Makeup Batch', 'Hands-on makeup classes at the studio.', 'in_person', 2500000, 500000, 365, 'published', 'active', ${past}, 2, ${past}, ${past});
    INSERT INTO batches (id, course_id, title, starts_on, ends_on, schedule_text, seats, seats_taken, status, created_at, updated_at)
    VALUES
      (410, 41, 'Last seat batch', '2027-01-11', '2027-01-30', 'Mon to Fri, 11 am to 2 pm', 1, 0, 'open', ${past}, ${past}),
      (411, 41, 'Weekend batch', '2027-02-06', '2027-03-28', 'Sat and Sun, 3 pm to 6 pm', 10, 0, 'open', ${past}, ${past});

    INSERT INTO coupons (id, code, percent_off, amount_off_paise, course_id, max_uses, used_count, active, allow_free, created_at, updated_at)
    VALUES
      (40, 'WELCOME10', 10, NULL, 40, NULL, 0, 1, 0, ${past}, ${past}),
      (41, 'GIFTGLOW', 100, NULL, 40, 5, 0, 1, 1, ${past}, ${past});
    UPDATE settings SET value = 'true' WHERE key = 'legal_confirmed';
  `;
}
