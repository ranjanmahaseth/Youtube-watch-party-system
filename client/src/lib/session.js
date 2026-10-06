const USER_ID_KEY = 'wwp:userId';
const USERNAME_KEY = 'wwp:username';
const HOST_TOKENS_KEY = 'wwp:hostTokens';
const SEAT_TOKENS_KEY = 'wwp:seatTokens';
const AUTH_TOKEN_KEY = 'wwp:authToken';
const AUTH_USER_KEY = 'wwp:authUser';

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) ?? '';
}

export function setAuthToken(token) {
  if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
  else localStorage.removeItem(AUTH_TOKEN_KEY);
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

export function getAuthUser() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setAuthUser(user) {
  if (user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(AUTH_USER_KEY);
}

export function clearAuthUser() {
  localStorage.removeItem(AUTH_USER_KEY);
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

function writeToken(key, roomId, token) {
  const tokens = readJson(key);

  if (token) tokens[roomId] = token;
  else delete tokens[roomId];

  localStorage.setItem(key, JSON.stringify(tokens));
}

/**
 * A stable id for this browser, so refreshing the page re-uses the same seat in
 * the room instead of appearing as a brand new user.
 */
export function getOrCreateUserId() {
  let userId = localStorage.getItem(USER_ID_KEY);
  if (!userId) {
    userId = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, userId);
  }
  return userId;
}

export function getRememberedUsername() {
  return localStorage.getItem(USERNAME_KEY) ?? '';
}

export function rememberUsername(username) {
  localStorage.setItem(USERNAME_KEY, username);
}

/**
 * Host tokens of the rooms this browser created are kept locally so that only
 * the creator can come back as host. Nobody else ever receives this token.
 */
export function rememberHostToken(roomId, hostToken) {
  writeToken(HOST_TOKENS_KEY, roomId, hostToken);
}

export function getHostToken(roomId) {
  return readJson(HOST_TOKENS_KEY)[roomId] ?? '';
}

/**
 * The secret proving this browser owns its seat in a room.
 *
 * The server issues one on every join and only restores a seat's role when it is
 * presented back. Without it, knowing someone's userId (which the room state
 * broadcasts to everybody) would be enough to take over their seat - and the
 * host's seat is the whole room.
 */
export function rememberSeatToken(roomId, seatToken) {
  writeToken(SEAT_TOKENS_KEY, roomId, seatToken);
}

export function getSeatToken(roomId) {
  return readJson(SEAT_TOKENS_KEY)[roomId] ?? '';
}

