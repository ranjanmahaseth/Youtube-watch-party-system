export const PLAYER_STATE = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
});

// Codes the IFrame API passes to the player's `onError` handler.
export const PLAYER_ERRORS = Object.freeze({
  2: 'That video ID is not valid.',
  5: 'This video cannot be played in the HTML5 player.',
  100: 'That video was not found, or it is private.',
  101: 'The owner does not allow this video to be embedded.',
  150: 'The owner does not allow this video to be embedded.',
});

// A YouTube id is always exactly 11 URL-safe base64 characters.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
]);

// Paths of the form youtube.com/<prefix>/<id>.
const ID_PATH_PREFIXES = new Set(['embed', 'v', 'shorts', 'live']);

/**
 * Pulls the 11-character video id out of any common YouTube link, or accepts a
 * bare id. Returns null when there is nothing usable, so callers can show a
 * validation message instead of loading a broken player.
 *
 * Handles: youtube.com/watch?v=ID, youtu.be/ID, /embed/ID, /v/ID, /shorts/ID,
 * /live/ID, m.youtube.com, music.youtube.com, youtube-nocookie.com, extra query
 * params (timestamps, playlists) and links typed without a protocol.
 *
 * This module is intentionally free of browser APIs so it can be unit tested
 * with plain Node (see client/test/youtube.test.mjs).
 */
export function extractVideoId(input) {
  const value = String(input ?? '').trim();
  if (!value) return null;

  // Already a bare id.
  if (VIDEO_ID_PATTERN.test(value)) return value;

  // Tolerate links typed without a protocol, e.g. "youtu.be/abc12345678".
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  let candidate = null;

  if (host === 'youtu.be') {
    [candidate] = segments;
  } else if (YOUTUBE_HOSTS.has(host)) {
    candidate = url.searchParams.get('v');

    if (!candidate && segments.length >= 2 && ID_PATH_PREFIXES.has(segments[0])) {
      candidate = segments[1];
    }
  }

  return candidate && VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

/** Builds the link people normally share, used for the player's "watch on YouTube". */
export function buildWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
