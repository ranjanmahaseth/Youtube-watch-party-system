import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * In-memory room store - the single source of truth for the MVP.
 *
 * Rooms live only inside this Node process. That is enough for a watch party:
 * one server owns the state and every client syncs from it. A database is
 * deliberately not used yet (see README).
 *
 * roomId -> room
 */
const rooms = new Map();

export const ROLES = Object.freeze({
  HOST: 'host',
  MODERATOR: 'moderator',
  PARTICIPANT: 'participant',
});

export const PLAY_STATE = Object.freeze({
  PLAYING: 'playing',
  PAUSED: 'paused',
});

// Room codes skip characters that are easy to confuse when read aloud or typed (0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_USERNAME_LENGTH = 24;
const DEFAULT_EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;

/**
 * How long an empty room survives so a page refresh does not destroy it.
 * Read lazily so the value from .env (loaded in index.js) is picked up.
 */
function emptyRoomTtlMs() {
  const parsed = Number(process.env.ROOM_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMPTY_ROOM_TTL_MS;
}

function randomRoomCode() {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomId(value) {
  return String(value ?? '').trim().toUpperCase();
}

export function normalizeUsername(value) {
  return String(value ?? '').trim().slice(0, MAX_USERNAME_LENGTH);
}

export function createRoom() {
  let id = randomRoomCode();
  while (rooms.has(id)) id = randomRoomCode();

  const room = {
    id,
    // Secret handed only to the creator. It is the *only* proof of "I am the host",
    // so the role can never be claimed by simply asking for it.
    hostToken: randomUUID(),
    createdAt: new Date().toISOString(),
    emptyTimer: null,
    /** What the room is watching. Everyone renders this, not a local choice. */
    video: { videoId: null, loadedBy: null },
    /**
     * Where the room is within that video.
     *
     * `updatedAt` is what lets the server tell a joiner the *current* position
     * without ever broadcasting ticks while playback runs.
     */
    playback: { playState: PLAY_STATE.PAUSED, currentTime: 0, updatedAt: Date.now() },
    /** userId -> { userId, username, role, socketId, joinedAt } */
    participants: new Map(),
    /** Rolling buffer of recent chat messages */
    messages: [],
  };

  rooms.set(id, room);
  return room;
}

export const MAX_CHAT_MESSAGES = 100;
export const MAX_CHAT_TEXT_LENGTH = 500;

export function addChatMessage(room, { userId, username, role, text }) {
  const trimmed = String(text ?? '').trim().slice(0, MAX_CHAT_TEXT_LENGTH);
  if (!trimmed) return null;

  const message = {
    id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    username,
    role,
    text: trimmed,
    timestamp: Date.now(),
  };

  if (!room.messages) room.messages = [];
  room.messages.push(message);
  if (room.messages.length > MAX_CHAT_MESSAGES) {
    room.messages.splice(0, room.messages.length - MAX_CHAT_MESSAGES);
  }

  return message;
}

export function getRoom(roomId) {
  const id = normalizeRoomId(roomId);
  return id ? rooms.get(id) ?? null : null;
}

export function scheduleRoomCleanup(room) {
  if (room.emptyTimer) return;

  room.emptyTimer = setTimeout(() => {
    rooms.delete(room.id);
    console.log(`[room] ${room.id} closed (empty)`);
  }, emptyRoomTtlMs());

  // Do not keep the process alive just to delete a room.
  room.emptyTimer.unref?.();
}

export function cancelRoomCleanup(room) {
  if (!room.emptyTimer) return;
  clearTimeout(room.emptyTimer);
  room.emptyTimer = null;
}

/**
 * Constant-time string comparison for the small secrets we hand out.
 * Returns false for anything that is not a non-empty string on both sides.
 */
function tokensMatch(expected, received) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof received !== 'string' || received.length === 0) return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isHostTokenValid(room, token) {
  return tokensMatch(room.hostToken, token);
}

/**
 * True when `seatToken` proves ownership of the seat `userId` currently holds.
 * A userId on its own is public knowledge, so this is the only thing that may
 * restore a seat's role.
 */
export function ownsSeat(room, userId, seatToken) {
  const existing = room.participants.get(userId);

  return existing !== undefined && tokensMatch(existing.seatToken, seatToken);
}

/**
 * Adds or re-adds a participant.
 *
 * Returns `{ conflict: true }` instead of a participant when the join would
 * displace a seat that is still live and cannot prove it owns it.
 *
 * Role rules, in order:
 *  1. A seat's role is only inherited by presenting the `seatToken` issued when
 *     that seat was created. A `userId` alone proves nothing - userIds are
 *     broadcast to everyone in the room in `sync_state`, so accepting one on
 *     trust would let any participant take over the host.
 *  2. The host role is never inherited at all. It is re-proven on every join
 *     from the host token, so even a leaked seat token cannot seize the room.
 *  3. Everything else defaults to participant.
 */
export function upsertParticipant(room, {
  userId,
  username,
  socketId,
  hostToken,
  seatToken,
  seatOccupied = false,
}) {
  const existing = room.participants.get(userId);
  const mayReclaimSeat = ownsSeat(room, userId, seatToken);

  if (existing && !mayReclaimSeat && seatOccupied && existing.socketId !== socketId) {
    return { conflict: true };
  }

  let role = mayReclaimSeat ? existing.role : ROLES.PARTICIPANT;
  if (role === ROLES.HOST) role = ROLES.PARTICIPANT;
  if (isHostTokenValid(room, hostToken)) role = ROLES.HOST;

  const participant = {
    userId,
    username: username || existing?.username || 'Guest',
    role,
    socketId,
    // Server-side only. Deliberately absent from toRoomState().
    seatToken: mayReclaimSeat ? existing.seatToken : randomUUID(),
    joinedAt: existing?.joinedAt ?? new Date().toISOString(),
  };

  room.participants.set(userId, participant);
  return { participant, isNew: !existing };
}

export function removeParticipant(room, userId) {
  const participant = room.participants.get(userId);
  if (!participant) return null;

  room.participants.delete(userId);
  return participant;
}

// A YouTube id is always exactly 11 URL-safe base64 characters.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function isValidVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
}

/**
 * A seek target must be a real, non-negative number of seconds.
 *
 * Rejecting outright rather than clamping keeps the client honest and makes the
 * rule easy to test. Note that a missing field arrives as `undefined` and a
 * JSON `NaN` arrives as `null`, so both fall through here.
 */
export function isValidSeekTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Who is allowed to change what the room is watching: the host and moderators.
 *
 * Deliberately a named, single definition so every privileged socket event goes
 * through the same check instead of repeating role comparisons inline.
 */
export function canControlPlayback(participant) {
  return participant?.role === ROLES.HOST || participant?.role === ROLES.MODERATOR;
}

/**
 * Who may eject someone else from the room: the host, and *only* the host.
 *
 * Deliberately separate from canControlPlayback. A moderator may play, pause,
 * seek and change the video, but must not be able to remove anyone. Reusing the
 * playback predicate here would silently grant moderators that power.
 */
export function canRemoveParticipants(participant) {
  return participant?.role === ROLES.HOST;
}

/**
 * Who may change someone else's role: the host, and only the host.
 *
 * Again a separate predicate. Keeping them apart means each command's rule is
 * stated once, in one place, and cannot drift when another is edited.
 */
export function canAssignRoles(participant) {
  return participant?.role === ROLES.HOST;
}

/**
 * Roles a host may hand out. `host` is deliberately absent: ownership is not
 * transferable, so there is always exactly one host.
 */
export const ASSIGNABLE_ROLES = Object.freeze([ROLES.MODERATOR, ROLES.PARTICIPANT]);

export function isAssignableRole(value) {
  return ASSIGNABLE_ROLES.includes(value);
}

export function setParticipantRole(room, userId, role) {
  const participant = room.participants.get(userId);
  if (!participant) return null;

  participant.role = role;
  return participant;
}

export function setRoomVideo(room, { videoId, loadedBy }) {
  room.video = { videoId, loadedBy };
  // A different video starts from the top, paused. Everyone is on equal footing.
  resetRoomPlayback(room);
  return room.video;
}

/**
 * The room's position right now.
 *
 * While the room is playing, wall-clock time has moved on since `updatedAt`, so
 * the stored `currentTime` is a baseline rather than the answer. This is the
 * whole reason ticks are not broadcast: the server can work it out on demand.
 */
export function currentPlaybackTime(room, now = Date.now()) {
  const { playState, currentTime, updatedAt } = room.playback;

  if (playState !== PLAY_STATE.PLAYING) return currentTime;

  return Math.max(0, currentTime + (now - updatedAt) / 1000);
}

/**
 * Flips play/pause, freezing the position first.
 *
 * `atTime` is an optional position reported by the client. It is used when it
 * is a real number so the stored position matches the actual player rather than
 * a projection that has drifted; otherwise the projection is used.
 */
export function setRoomPlayState(room, playState, atTime) {
  const currentTime = Number.isFinite(atTime) ? atTime : currentPlaybackTime(room);

  room.playback = { playState, currentTime, updatedAt: Date.now() };
  return room.playback;
}

/** Moves the position without changing play/pause. */
export function setRoomTime(room, currentTime) {
  room.playback = { ...room.playback, currentTime, updatedAt: Date.now() };
  return room.playback;
}

export function resetRoomPlayback(room) {
  room.playback = { playState: PLAY_STATE.PAUSED, currentTime: 0, updatedAt: Date.now() };
  return room.playback;
}

/**
 * The public snapshot of a room that clients receive.
 * Never exposes hostToken or socket ids.
 */
export function toRoomState(room, now = Date.now()) {
  return {
    roomId: room.id,
    video: { videoId: room.video.videoId, loadedBy: room.video.loadedBy },
    // The room state a joiner needs: videoId (above), playState and currentTime.
    // currentTime is projected, so a joiner is told 3:42 and not a stale 3:40.
    playback: {
      playState: room.playback.playState,
      currentTime: Math.round(currentPlaybackTime(room, now) * 1000) / 1000,
    },
    participants: [...room.participants.values()]
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
      .map(({ userId, username, role }) => ({ userId, username, role })),
    messages: room.messages ? [...room.messages] : [],
  };
}
