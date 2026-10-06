import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { User } from './models/User.js';
import { Room } from './models/Room.js';

let isConnected = false;

// Re-export models for convenient imports across the codebase
export { User, Room };
export const UserModel = User;
export const RoomModel = Room;

// In-memory fallback stores when MongoDB is not connected
const inMemoryUsers = new Map(); // username -> user

/**
 * Connect to MongoDB if MONGODB_URI is provided.
 * Falls back to in-memory mode if URI is absent.
 */
export async function setupDatabase() {
  const mongoUri = process.env.MONGODB_URI?.trim();

  if (!mongoUri) {
    console.log('[db] MONGODB_URI not configured. Running with in-memory persistence & auth fallback.');
    return;
  }

  try {
    console.log('[db] Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    console.log('[db] Successfully connected to MongoDB.');

    mongoose.connection.on('disconnected', () => {
      isConnected = false;
      console.warn('[db] MongoDB disconnected. Falling back to in-memory mode.');
    });

    mongoose.connection.on('reconnected', () => {
      isConnected = true;
      console.log('[db] MongoDB reconnected.');
    });
  } catch (err) {
    isConnected = false;
    console.error(`[db] MongoDB connection failed: ${err.message}. Running in in-memory mode.`);
  }
}

export function isDbActive() {
  return isConnected && mongoose.connection.readyState === 1;
}

// ----------------- USER HELPERS -----------------

export async function findUserByUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) return null;

  if (isDbActive()) {
    try {
      const user = await UserModel.findOne({ username: new RegExp(`^${normalized}$`, 'i') }).lean();
      if (user) {
        return {
          id: user._id.toString(),
          username: user.username,
          password: user.password,
          email: user.email,
          createdAt: user.createdAt,
        };
      }
    } catch (err) {
      console.error('[db] Error finding user in MongoDB:', err.message);
    }
  }

  // In-memory fallback
  return inMemoryUsers.get(normalized) || null;
}

export async function findUserById(id) {
  if (!id) return null;

  if (isDbActive()) {
    try {
      const user = await UserModel.findById(id).lean();
      if (user) {
        return {
          id: user._id.toString(),
          username: user.username,
          email: user.email,
          createdAt: user.createdAt,
        };
      }
    } catch (err) {
      console.error('[db] Error finding user by ID in MongoDB:', err.message);
    }
  }

  // In-memory fallback
  for (const user of inMemoryUsers.values()) {
    if (user.id === id) {
      return { id: user.id, username: user.username, email: user.email, createdAt: user.createdAt };
    }
  }
  return null;
}

export async function createUser({ username, password, email = '' }) {
  const normalizedKey = String(username).trim().toLowerCase();

  if (isDbActive()) {
    try {
      const newUser = await UserModel.create({
        username: String(username).trim(),
        password,
        email: String(email).trim(),
      });
      return {
        id: newUser._id.toString(),
        username: newUser.username,
        email: newUser.email,
        createdAt: newUser.createdAt,
      };
    } catch (err) {
      if (err.code === 11000) {
        throw new Error('USERNAME_TAKEN');
      }
      throw err;
    }
  }

  // In-memory fallback
  if (inMemoryUsers.has(normalizedKey)) {
    throw new Error('USERNAME_TAKEN');
  }

  const memoryUser = {
    id: `usr_${randomUUID().slice(0, 8)}`,
    username: String(username).trim(),
    password,
    email: String(email).trim(),
    createdAt: new Date().toISOString(),
  };
  inMemoryUsers.set(normalizedKey, memoryUser);
  return {
    id: memoryUser.id,
    username: memoryUser.username,
    email: memoryUser.email,
    createdAt: memoryUser.createdAt,
  };
}

// ----------------- ROOM PERSISTENCE HELPERS -----------------

export async function saveRoomToDb(room) {
  if (!isDbActive() || !room?.id) return;

  try {
    await RoomModel.findOneAndUpdate(
      { roomId: room.id },
      {
        roomId: room.id,
        hostToken: room.hostToken,
        video: {
          videoId: room.video?.videoId ?? null,
          loadedBy: room.video?.loadedBy ?? null,
        },
        playback: {
          playState: room.playback?.playState ?? 'paused',
          currentTime: room.playback?.currentTime ?? 0,
          updatedAt: room.playback?.updatedAt ?? Date.now(),
        },
        messages: Array.isArray(room.messages) ? room.messages.slice(-100) : [],
        lastActiveAt: new Date(),
        isClosed: false,
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.error(`[db] Failed to save room ${room.id} to MongoDB:`, err.message);
  }
}

export async function loadRoomFromDb(roomId) {
  if (!isDbActive() || !roomId) return null;

  try {
    const doc = await RoomModel.findOne({ roomId: String(roomId).trim().toUpperCase() }).lean();
    if (!doc || doc.isClosed) return null;

    return {
      id: doc.roomId,
      hostToken: doc.hostToken,
      createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
      emptyTimer: null,
      video: doc.video || { videoId: null, loadedBy: null },
      playback: doc.playback || { playState: 'paused', currentTime: 0, updatedAt: Date.now() },
      participants: new Map(),
      messages: doc.messages || [],
    };
  } catch (err) {
    console.error(`[db] Failed to load room ${roomId} from MongoDB:`, err.message);
    return null;
  }
}

export async function markRoomClosedInDb(roomId) {
  if (!isDbActive() || !roomId) return;

  try {
    await RoomModel.updateOne({ roomId: String(roomId).trim().toUpperCase() }, { isClosed: true });
  } catch (err) {
    console.error(`[db] Failed to mark room ${roomId} closed in MongoDB:`, err.message);
  }
}

