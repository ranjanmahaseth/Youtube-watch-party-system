import { io } from 'socket.io-client';

/**
 * Public URL of the backend, supplied by `VITE_SERVER_URL`.
 *
 * Vite inlines this at build time, so it is fixed for the life of the bundle.
 * The localhost fallback is only ever meant for `npm run dev`: a production
 * build without the variable is rejected by vite.config.js before it can ship,
 * which is what stops a deployed bundle pointing at a developer's machine.
 */
const configuredUrl = import.meta.env.VITE_SERVER_URL;

/**
 * Only a *development* build may fall back to localhost.
 *
 * `import.meta.env.DEV` is replaced with `false` at build time, so the literal
 * below is dropped from a production bundle entirely - a deployed artefact
 * contains no localhost URL at all, not merely an unreachable one. A production
 * build without VITE_SERVER_URL is refused by vite.config.js before it gets
 * this far.
 */
export const SERVER_URL = configuredUrl || (import.meta.env.DEV ? 'http://localhost:5000' : '');

if (import.meta.env.PROD && !configuredUrl) {
  // Defence in depth - the build should already have refused this.
  console.error(
    '[config] VITE_SERVER_URL was not set at build time. This bundle will try to reach ' +
      `${SERVER_URL} and fail. Rebuild with VITE_SERVER_URL set to the deployed backend.`,
  );
}

/**
 * One shared Socket.IO connection for the whole app.
 *
 * - Created once here, at module load, so no component ever calls `io()` again.
 * - `autoConnect: false` means nothing is opened until the user creates or
 *   joins a room.
 * - Reconnection stays on; App.jsx listens for `connect`/`disconnect` to show
 *   the status and to restore the user's seat after a dropped connection.
 * - Transports are left at the default (polling, then upgrade to WebSocket),
 *   which is what behaves cleanly behind Render's proxy.
 */
export const socket = io(SERVER_URL, {
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
});

if (import.meta.env.DEV) {
  // Dev-only handle so the server's permission checks can be exercised by hand
  // from the browser console, e.g.
  //   __watchPartySocket.emit('play', {}, console.log)  // -> { ok: false, error: 'FORBIDDEN' }
  // Stripped from production builds by Vite.
  window.__watchPartySocket = socket;
}

