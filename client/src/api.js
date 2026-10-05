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

