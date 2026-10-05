# YouTube Watch Party

Project scaffolding for a YouTube Watch Party system. This stage contains **setup only** —
no rooms, no YouTube integration, no roles, and no playback synchronization yet.

## Structure

```
youtube-watch-party/
├── client/                       # React + Vite (JavaScript) + Tailwind CSS
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Banner.jsx        # reusable notice strip
│   │   │   ├── Home.jsx          # create / join screen
│   │   │   ├── Room.jsx          # room screen (code, roles, participants)
│   │   │   ├── VideoPanel.jsx    # link box + player + local controls
│   │   │   └── YouTubePlayer.jsx # IFrame API wrapper (imperative handle)
│   │   ├── lib/
│   │   │   ├── session.js        # browser identity + stored host tokens
│   │   │   ├── youtube.js        # pure: video id parsing, player constants
│   │   │   └── youtubeApi.js     # loads the IFrame API exactly once
│   │   ├── App.jsx               # owns state, the only Socket.IO consumer
│   │   ├── api.js                # REST calls (create room, check room)
│   │   ├── index.css             # Tailwind entry point
│   │   ├── main.jsx
│   │   ├── socket.js             # the single shared Socket.IO connection
│   │   └── ui.js                 # shared Tailwind class strings
│   ├── test/
│   │   └── youtube.test.mjs      # unit tests for extractVideoId
│   ├── .env
│   ├── .env.example
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── server/                  # Node.js + Express + Socket.IO
│   ├── src/
│   │   ├── index.js
│   │   ├── roomStore.js
│   │   └── socketHandlers.js
│   ├── test/
│   │   └── smoke.mjs
│   ├── .env
│   ├── .env.example
│   └── package.json
├── README.md
└── .gitignore
```

## Tech stack

| Layer    | Stack                                                       |
| -------- | ----------------------------------------------------------- |
| Frontend | React, Vite, JavaScript, Tailwind CSS, `socket.io-client`    |
| Backend  | Node.js, Express, Socket.IO, CORS, dotenv                    |

> Styling uses **Tailwind CSS v4** via the `@tailwindcss/vite` plugin. v4 needs
> no `tailwind.config.js` — the theme is defined in CSS, and `src/index.css`
> is the single entry point (`@import 'tailwindcss';`).
>
> MongoDB is intentionally **not** added yet.


## Prerequisites

- Node.js 18+ (developed/tested on Node 22)
- npm 9+

## Install

Run the install once inside each folder:

```bash
# backend
cd server
npm install

# frontend
cd client
npm install
```

## Environment variables

Both `.env` files are created with working defaults and are git-ignored. Use the
matching `.env.example` files as templates - they document every key.

`server/.env`

```
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
```

`client/.env`

```
VITE_SERVER_URL=http://localhost:5000
```

> `VITE_SERVER_URL` is read at **build** time, not runtime - Vite inlines it into
> the bundle. Changing it locally requires restarting the dev server, and on
> Render it must be a build-time variable. See [Deploying to Render](#deploying-to-render).


## Run

Open **two terminals**.

Backend (from `server/`):

```bash
npm run dev      # node --watch, auto-restarts on change
# or
npm start        # plain node
```

Frontend (from `client/`):

```bash
npm run dev
```

Then open the URL printed by Vite (default `http://localhost:5173`).

## YouTube integration

The player is the official **YouTube IFrame Player API** (`https://www.youtube.com/iframe_api`).

- `src/lib/youtubeApi.js` injects the script once and caches the promise at
  module scope, so the API is never loaded twice. The API exposes only a single
  `window.onYouTubeIframeAPIReady` slot, which this module owns; a script
  injected by someone else is reused rather than duplicated, the load has a
  timeout, and a failure rejects so the UI can report it.
- `src/lib/youtube.js` is pure (no DOM). It turns any common YouTube link into a
  video id and rejects anything unusable. Because it has no browser
  dependencies it is unit tested with plain Node.
- `src/components/YouTubePlayer.jsx` wraps the player and exposes an imperative
  handle through `ref`: `play()`, `pause()`, `seekTo(seconds)`,
  `loadVideo(id)`, `getCurrentTime()`, `getPlayerState()`, `getPlayer()`.

The room's video is **shared state owned by the server**, so every participant
renders the same video:

```
host/moderator pastes a link
  -> the client extracts the video id (lib/youtube.js)
  -> socket.emit('change_video', { videoId })
  -> server: authorizePrivileged()   host or moderator only -> FORBIDDEN otherwise
  -> server: isValidVideoId(videoId) 11 URL-safe chars      -> INVALID_VIDEO_ID otherwise
  -> server: setRoomVideo(room, { videoId, loadedBy })      room state is updated
  -> server: ack { ok: true }
  -> socket.to(room).emit('change_video', ...)   display-only notice (activity feed)
  -> io.to(room).emit('sync_state', ...)         authoritative snapshot, everyone
  -> every client's player loads that video
```

Note the two different broadcast targets. `socket.to` (everyone *except* the
sender) is used for the notice because the sender already got the ack. `io.to`
(everyone) is used for `sync_state` because - unlike play/pause/seek - the sender
never held this video locally. **The video is only ever set from `sync_state`**;
the `change_video` notice cannot change what a client is watching. That is the
single path that prevents frontend-only state changes.

### Room state and the join snapshot

`toRoomState()` is the only shape clients ever see. It carries the three fields a
joiner needs, plus the participant list:

```js
{
  roomId,
  video:        { videoId, loadedBy },              // what
  playback:     { playState, currentTime },         // where, and doing what
  participants: [{ userId, username, role }],
}
```

**The server never broadcasts ticks.** `playback.currentTime` is stored as a
*baseline* next to `updatedAt`, and the value handed out is projected forward
while the room is playing:

```js
currentTime + (now - updatedAt) / 1000      // only while playState === 'playing'
```

So a joiner is told 3:42, not the 3:40 that was true the last time the host
paused. That is what makes it safe to send nothing but the dedicated
`play` / `pause` / `seek` events during playback.

**What updates state, and what is broadcast:**

| Event | Room state | Broadcast |
| --- | --- | --- |
| `join_room` | – | snapshot in the ack; `sync_state` to the **others** only |
| `play` | `playState = playing` | `play` only |
| `pause` | position frozen, `playState = paused` | `pause` only |
| `seek` | `currentTime = time` | `seek` only |
| `change_video` | video replaced, playback reset to paused/0 | notice + `sync_state` to everyone |
| join / leave | participant list | `sync_state` to everyone |

`play` and `pause` accept an optional `time`. When it is a real number the server
trusts it over its own projection, so the stored position tracks the actual player
instead of drifting; when it is missing the projection is used.

**How a new user is synchronised.** Join is request/response, so nothing is
broadcast back to the joiner:

1. the client emits `join_room` and gets `{ ok: true, state }` back in the ack;
2. `App` keeps that snapshot in its own `syncTarget` (tagged with a nonce), kept
   separate from `roomState` because `roomState` changes constantly as people come
   and go, whereas a join snapshot must be applied exactly once;
3. `Room` → `VideoPanel` → one effect applies it.

**Player readiness.** A join snapshot almost always arrives before the YouTube
player has finished booting. That effect has `status` in its dependency list, so
it runs, does nothing, and runs again the moment the player reports ready. That is
the whole readiness mechanism - no polling, no retries, no timers.

It is a *single* effect rather than a "load" effect plus a "seek" effect because
the order is load-bearing: a seek issued before the video is cued is silently
dropped. Handing `startSeconds` to `cueVideoById` removes the race completely.



**Seeking** is documented below. The permission checks for `play`, `pause`,
`seek` and `change_video` all follow the rule that the backend validates roles;
none of them rely on the UI hiding a button.

### Seek synchronisation

```
host/moderator moves the scrubber (or uses our +/-10s buttons)
  -> the drift detector notices the player is no longer where it should be
  -> the emit is debounced: 300 ms after the player last moved
  -> socket.emit('seek', { time })
  -> the server re-checks the role, then validates `time`
  -> socket.to(room).emit('seek', { time })     <- everyone EXCEPT the sender
  -> every other client calls player.seekTo(time)
```

**Why a detector is needed.** The IFrame API has no "the user seeked" event, and
dragging YouTube's own progress bar emits nothing usable. So `VideoPanel` polls
every 400 ms and compares `getCurrentTime()` against where the player would be if
it had simply kept playing. A gap larger than 1.5 s means a seek happened.

**Why that cannot flood the socket.** The poll only ever *triggers* a debounce.
The emit happens 300 ms after the player stops moving, so dragging across the
whole bar - dozens of position changes - produces exactly one message. The drift
check is also skipped while the player is buffering, and for a short window after
applying a seek that came from the server (otherwise the applier would report the
seek back).

**Time validation.** `isValidSeekTime()` accepts only a finite, non-negative
`number`. A missing field, `null`, a string, an object or a negative value all
get `{ ok: false, error: 'INVALID_TIME' }` and are never forwarded to the room.
Authorization is checked *before* validation, so a refused client learns nothing
about our payload rules.

## Roles and permissions

Two predicates in `roomStore.js`, deliberately kept apart:

| Predicate | Allows | Used by |
| --- | --- | --- |
| `canControlPlayback()` | host **and** moderator | `play`, `pause`, `seek`, `change_video` |
| `canRemoveParticipants()` | **host only** | `remove_participant` |

They are separate on purpose. Reusing the playback predicate for removal would
silently give moderators the power to eject people.

`authorizePrivileged(socket, event, ack, can)` takes the rule as a parameter, so
the difference is visible at each call site rather than buried in a shared helper.

### Removing a participant

```
host clicks Remove on someone else's row
  -> socket.emit('remove_participant', { userId })
  -> server: canRemoveParticipants()  host only      -> FORBIDDEN
  -> server: is it the caller?                       -> CANNOT_REMOVE_SELF
  -> server: does that participant exist?            -> PARTICIPANT_NOT_FOUND
  -> server: removeParticipant(room, userId)          room state updated
  -> server: ack { ok: true }
  -> io.to(room).emit('participant_removed', ...)     the WHOLE room
  -> server: clear socket.data, socket.leave(roomId)
  -> io.to(room).emit('sync_state', ...)              survivors only, from here
  -> server: targetSocket.disconnect(true)
```

**Identifying the target's socket.** Each participant record stores the
`socketId` it was last seen on, refreshed on every join, so the live Socket is
just `io.sockets.sockets.get(target.socketId)`. If that lookup returns nothing
(the socket vanished between the two steps) the removal still completes from room
state and the survivors still get the fresh list - a stale socket id is not
treated as an error.

**Why that exact order.** The notification is emitted while the target is still
attached, so it cannot be lost in the connection close. `socket.data` is cleared
*before* `disconnect()` so the disconnect handler does not try to remove an
already-removed participant a second time. `sync_state` goes out after `leave()`,
so the departed user is no longer a recipient of it.

**How the frontend handles it.** The same `participant_removed` event reaches
everyone; each client decides whether it is about itself by comparing `userId`
with its own, so one event covers both audiences. For the target:

1. clear `sessionRef` **first** - otherwise the incoming disconnect would be
   followed by an automatic re-join and the removal would undo itself;
2. clear the room state, which sends `App` back to the Home screen with an
   explanatory banner;
3. `socket.disconnect()` - a deliberate leave, so Socket.IO does not reconnect.

Everyone else simply logs "X was removed from the room" in the activity feed.

### Changing a role

```
host clicks Promote / Demote on someone else's row
  -> socket.emit('assign_role', { userId, role })   role: 'moderator' | 'participant'
  -> server: canAssignRoles()   host only           -> FORBIDDEN
  -> server: is it the caller?                      -> CANNOT_CHANGE_OWN_ROLE
  -> server: is the role assignable?                -> INVALID_ROLE
  -> server: does that participant exist?           -> PARTICIPANT_NOT_FOUND
  -> server: setParticipantRole(room, userId, role)
  -> server: ack { ok: true }
  -> io.to(room).emit('role_assigned', ...)          notice for the activity feed
  -> io.to(room).emit('sync_state', ...)             everyone's list changed
```

`host` is deliberately **not** an assignable role. Ownership is not transferable,
which is what guarantees there is always exactly one host and a room can never be
left ownerless.

`io.to` (not `socket.to`) because a role change shows up in *everyone's*
participant list, the host's included - there is no "the sender already knows"
shortcut here.

### Seat ownership

Joining returns a **`seatToken`** in the ack, alongside the room state. A seat's
role is only restored when that secret comes back with the join:

| Join | Result |
| --- | --- |
| `userId` already seated **and** still live, no matching token | `SEAT_TAKEN` - refused |
| `userId` already seated, matching token | seat and role restored (e.g. a second tab) |
| `userId` not currently seated | a fresh participant seat |

Separately, the **host role is never inherited**. It is re-proven on every join
from the host token, so even a leaked seat token cannot seize the room.

Without these rules, knowing someone's `userId` was enough to take their seat -
and `sync_state` broadcasts every `userId` to everybody in the room, so any
participant could have claimed the host. Found during the QA pass below.

A seat does **not** survive its socket: a disconnect removes the participant
outright, so a moderator who refreshes returns as a participant. The host
survives because the host token is re-proven. Resetting privileges on disconnect
is the safer default; preserving moderator seats across a refresh would need a
separate seat ledger with its own expiry.


## Interface

| Screen | Layout |
| --- | --- |
| Home | Centred single column, max `3xl`. The Create and Join cards sit side by side from `sm` upward. |
| Room | Single column on mobile. From `lg` upward the player and activity take the main column, with identity and participants in a 20rem sidebar. |

Role-appropriate controls (all UX only - the server re-checks every one):

| Role | Sees |
| --- | --- |
| Host | video link box, playback + seek controls, **Promote / Demote / Remove** on every other row |
| Moderator | video link box, playback + seek controls |
| Participant | none of the above, plus a click-blocking layer over the player itself |

Feedback surfaces: a connection dot in the header (green connected / amber
reconnecting), red banners for refused actions and invalid input, inline
validation on the YouTube link, and an activity feed for joins, leaves, removals
and role changes.

No animation library, no icon package and no component library were added: one
inline SVG play glyph on the landing page, and one extra shared class string
(`BTN_ROW`) in `ui.js`.




### Play/pause synchronisation

```
host/moderator plays or pauses (our button OR YouTube's own controls)
  -> the player's onStateChange fires
  -> socket.emit('play' | 'pause')
  -> the server re-checks the role
  -> socket.to(room).emit('play' | 'pause')    <- everyone EXCEPT the sender
  -> every other client calls player.play() / player.pause()
```

**Backend permission validation.** `play`, `pause` and `change_video` all route
through `canControlPlayback()` in `roomStore.js`, which allows only `host` and
`moderator`. A participant who bypasses the UI and emits directly is refused on
two channels: the ack carries `{ ok: false, error: 'FORBIDDEN' }`, and a
`permission_denied` event is emitted to that socket. The dedicated event is the
one that matters, because a malicious client would simply omit the ack callback.

**Why it cannot loop.** Two independent guards:

1. *Server side* - the broadcast uses `socket.to(room)`, not `io.to(room)`. That
   excludes the sender, so a client never receives back the event it just sent.
2. *Client side* - `VideoPanel` keeps a `remoteExpectedRef` flag. While it is
   applying a command that came from the server, every `onStateChange` is
   ignored, so the client does not report the change it was just told to make.
   The flag clears as soon as the player reaches the requested state, with a 2s
   timeout as a safety net for when the player never changes at all.

There is also a **single outbound code path**: `onStateChange` is the only place
that emits. That is why our own "Play for everyone" button and YouTube's built-in
play button both synchronise, and why a remote command cannot echo.


## Testing

```bash
# backend: rooms, roles, permissions, ack contract
cd server && npm run test:smoke

# frontend: YouTube url parsing
cd client && npm test
```

Both are dependency-free Node scripts — no test framework installed.

## Deploying to Render

Two Render services, matching the architecture the app was built for:

```
Browser
  ├─ HTTPS  https://<frontend>.onrender.com   Static Site  (React + Vite)
  └─ WSS    https://<backend>.onrender.com    Web Service  (Express + Socket.IO)
```

Create the **backend first** - its URL is a required input for the frontend.

### 1. Backend - Web Service

| Setting | Value |
| --- | --- |
| Root Directory | `server` |
| Runtime | `Node` |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Instance Type | Free (fine for a demo) |

`npm start` runs `node src/index.js`. There is no compile step - it is plain Node
with ESM (`"type": "module"`). `--omit=dev` skips `socket.io-client`, which only
the smoke test needs.

**Environment variables**

| Key | Value | Notes |
| --- | --- | --- |
| `CLIENT_ORIGIN` | `https://<your-frontend>.onrender.com` | Fill in after step 2 |
| `NODE_ENV` | `production` | Enables the CORS startup warning |
| `PORT` | **do not set** | Render injects it; the code reads `process.env.PORT` |
| `ROOM_TTL_MS` | *optional* | Defaults to 5 minutes |

### 2. Frontend - Static Site

| Setting | Value |
| --- | --- |
| Root Directory | `client` |
| Build Command | `npm ci --include=dev && npm run build` |
| Publish Directory | `dist` |

`--include=dev` matters: `vite`, `@vitejs/plugin-react` and `tailwindcss` are all
devDependencies, so a build that skips them fails.

**Environment variables**

| Key | Value |
| --- | --- |
| `VITE_SERVER_URL` | `https://<your-backend>.onrender.com` |

Then set `CLIENT_ORIGIN` on the backend to this service's URL and redeploy it.

### Why `VITE_SERVER_URL` is a build-time variable

Vite **inlines** `VITE_*` values into the bundle during the build. It is not read
at runtime, so changing it needs a rebuild rather than a restart. A production
build with it missing is **rejected by `client/vite.config.js`** instead of
quietly shipping a localhost URL:

```
error during build:
Error: VITE_SERVER_URL is required for a production build.
```

### CORS

One variable drives both transports:

- `CLIENT_ORIGIN` is a comma-separated allow-list applied to Express (`cors()`)
  **and** to the Socket.IO server.
- Trailing slashes are stripped, because browsers send `Origin` without one.
- With `NODE_ENV=production`, a leftover `localhost` entry logs a warning at boot
  rather than failing silently in the browser:

  ```
  [server] CLIENT_ORIGIN still contains a localhost origin (http://localhost:5173).
  The deployed frontend will be blocked by CORS - set CLIENT_ORIGIN to its real URL.
  ```

Several origins: `https://a.onrender.com,https://b.onrender.com`.

### Production Socket.IO URL

REST and WebSocket share one origin, so a single value covers both:

```
VITE_SERVER_URL=https://<your-backend>.onrender.com
```

The client calls `io(SERVER_URL)` with the default transports (HTTP polling, then
upgrade to WebSocket), which is what behaves cleanly behind Render's
TLS-terminating proxy. No extra configuration is required.

### Deploy order

1. Create the backend service. `CLIENT_ORIGIN` can be a placeholder for now.
2. Create the frontend service with `VITE_SERVER_URL` set to the backend URL.
3. Copy the frontend URL into the backend's `CLIENT_ORIGIN` and redeploy.
4. Open the frontend, create a room, and confirm the connection dot is green.

### Gotchas

- **Free instances sleep.** After ~15 minutes idle the backend spins down and the
  next request takes 30-50s to wake. The client shows "Reconnecting…" meanwhile.
- **Rooms are in memory.** A restart or a spin-down clears every room.
- **No secrets in Git.** Nothing here is secret - host and seat tokens are
  generated at runtime - but `server/.env` and `client/.env` are git-ignored;
  `.env.example` is the committed template.
- **No SPA rewrite needed.** The app uses a `?room=CODE` query parameter rather
  than path routing, so deep links resolve to `index.html` already.

### Verified before writing this

- A production build with `VITE_SERVER_URL` set contains that URL and **no**
  `http://localhost:5000` anywhere in the bundle.
- A production build without it fails with the message above.
- With `PORT=5077` and `NODE_ENV=production` the server logs
  `listening on port 5077 (production)` and answers `/api/health` with 200.
- A trailing slash in `CLIENT_ORIGIN` still returns the correct
  `access-control-allow-origin`.
- `npm run test:smoke` → 97/97 after the changes.


