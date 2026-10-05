import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createRoom, getRoom } from './roomStore.js';
import { registerSocketHandlers } from './socketHandlers.js';
import { searchYouTube } from './youtubeSearch.js';

dotenv.config({ quiet: true });

const PORT = process.env.PORT || 5000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Origins allowed to call the REST API and open a socket.
 *
 * Comma separated so the deployed frontend can be added without touching code.
 * A trailing slash is stripped because browsers send the Origin header without
 * one, and `https://app.onrender.com/` would otherwise never match.
 */
const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

if (
  IS_PRODUCTION &&
  ALLOWED_ORIGINS.some((origin) => origin.includes('localhost') || origin.includes('127.0.0.1'))
) {
  console.warn(
    `[server] CLIENT_ORIGIN still contains a localhost origin (${ALLOWED_ORIGINS.join(', ')}). ` +
      'The deployed frontend will be blocked by CORS - set CLIENT_ORIGIN to its real URL.',
  );
}

const app = express();

// Render terminates TLS and forwards the request, so the real client IP and
// protocol arrive in headers. Trusting the first hop keeps req.ip and
// req.protocol correct - needed the moment request throttling is added.
app.set('trust proxy', 1);

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'YouTube Watch Party API is running' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Creates a room. The secret host token is returned to the creator only.
app.post('/api/rooms', (req, res) => {
  const room = createRoom();
  console.log(`[room] ${room.id} created`);
  res.status(201).json({ roomId: room.id, hostToken: room.hostToken });
});

// Lets the join screen verify a code before opening a socket.
app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ exists: false });

  return res.json({
    exists: true,
    roomId: room.id,
    participantCount: room.participants.size,
  });
});

// Searches YouTube videos by query or direct URL/ID.
app.get('/api/youtube/search', async (req, res) => {
  const query = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    return res.json({ results: [] });
  }

  try {
    const results = await searchYouTube(query);
    return res.json({ results });
  } catch (error) {
    console.error(`[youtube] search failed for "${query}":`, error.message);
    return res.status(500).json({ error: 'Failed to search YouTube videos. Try again or paste a direct video link.' });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
});

registerSocketHandlers(io);

httpServer.listen(PORT, () => {
  // 0.0.0.0 is implicit when no host is given, which is what Render needs.
  console.log(`[server] listening on port ${PORT} (${IS_PRODUCTION ? 'production' : 'development'})`);
  console.log(`[server] allowing CORS from ${ALLOWED_ORIGINS.join(', ')}`);
});
