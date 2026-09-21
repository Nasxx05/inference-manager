/**
 * External destinations.
 *
 * Kept in one place so the UI and the tests cannot drift apart, and so the
 * security-critical `rel` value is defined once next to the URL it belongs to.
 */

/** Where users top up the CREDIT they spend on planning. */
export const BUY_CREDITS_URL = "https://orbio.so";

/** The walkthrough embedded in the "How to use" dialog. */
export const HOW_TO_USE_VIDEO_ID = "lX3L2aQozeA";
export const HOW_TO_USE_VIDEO_EMBED_URL = `https://www.youtube-nocookie.com/embed/${HOW_TO_USE_VIDEO_ID}`;
export const HOW_TO_USE_VIDEO_WATCH_URL = `https://www.youtube.com/watch?v=${HOW_TO_USE_VIDEO_ID}`;

/**
 * Every external link opens in a new tab, so `noopener` (blocks window.opener
 * tampering) and `noreferrer` (strips the referrer) travel with it.
 */
export const EXTERNAL_LINK_REL = "noopener noreferrer";