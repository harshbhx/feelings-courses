/**
 * Payment facts shared by the checkout's server (functions/_lib/checkout.ts) and its browser script
 * (src/components/checkout/Checkout.astro).
 */

/**
 * Razorpay's public TEST Key ID. Not a secret: a Key ID is public by design, because Razorpay
 * Checkout sends it to the browser anyway. It works in Test Mode only, so it can never move money.
 * The owner approved committing it on 2026-10-21.
 *
 * It lets the demo course open Razorpay's real Checkout before the owner has a Razorpay account
 * (mode "razorpay-test" in functions/_lib/checkout.ts). Only ever used while `course.demo` is true.
 *
 * Never add a Key Secret here, or anywhere in the repo: secrets go in Cloudflare's Variables and
 * Secrets only (see README, Payments).
 */
export const RAZORPAY_TEST_KEY_ID = "rzp_test_1DP5mmOlF5G5ag";

/**
 * Instagram's and Facebook's in-app browsers (and Android web views), where Razorpay Checkout
 * can't open its window in a frame. Matched against the User-Agent, in the browser and on the server.
 */
export const IN_APP_BROWSER = /Instagram|FBAN|FBAV|FB_IAB|; wv\)/i;
