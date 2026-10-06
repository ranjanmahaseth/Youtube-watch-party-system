import { SERVER_URL } from './socket.js';

/** Creates a room and returns { roomId, hostToken }. */
export async function createRoom() {
  const response = await fetch(`${SERVER_URL}/api/rooms`, { method: 'POST' });
  if (!response.ok) throw new Error(`Failed to create room (${response.status})`);
  return response.json();
}

/** Checks a room code before opening a socket. */
export async function roomExists(roomId) {
  const response = await fetch(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}`);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Failed to check room (${response.status})`);
  return true;
}

/** Searches YouTube videos by keyword or direct URL/ID. */
export async function searchYouTube(query) {
  const response = await fetch(`${SERVER_URL}/api/youtube/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to search YouTube (${response.status})`);
  }
  const data = await response.json();
  return data.results || [];
}

/** Registers a new account. */
export async function registerUser(username, password, email = '') {
  const response = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, email }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Registration failed (${response.status})`);
  }
  return data;
}

/** Logs in with username and password. */
export async function loginUser(username, password) {
  const response = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Login failed (${response.status})`);
  }
  return data;
}

/** Fetches currently logged-in user with JWT token. */
export async function fetchCurrentUser(token) {
  if (!token) return null;
  const response = await fetch(`${SERVER_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return data.user || null;
}
