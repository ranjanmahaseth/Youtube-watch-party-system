import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';

let pubClient = null;
let subClient = null;
let isRedisConnected = false;

/**
 * Initializes Redis connection and configures the Socket.IO Redis adapter
 * if REDIS_URL is provided in environment variables.
 *
 * If REDIS_URL is not set or if the connection fails, it logs gracefully
 * and falls back to standard in-memory Socket.IO operation without crashing.
 *
 * @param {import('socket.io').Server} io
 */
export async function setupRedis(io) {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    console.log('[redis] REDIS_URL not configured. Running in default in-memory mode.');
    return { isReady: false };
  }

  try {
    console.log('[redis] Connecting to Redis at', redisUrl.replace(/:[^:@]*@/, ':****@'));

    pubClient = createClient({ url: redisUrl });
    subClient = pubClient.duplicate();

    pubClient.on('error', (err) => console.warn('[redis] Pub client error:', err.message));
    subClient.on('error', (err) => console.warn('[redis] Sub client error:', err.message));

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));
    isRedisConnected = true;

    console.log('[redis] Socket.IO Redis Adapter enabled successfully (multi-server scaling active).');
    return { isReady: true, pubClient, subClient };
  } catch (error) {
    console.error('[redis] Failed to connect to Redis:', error.message);
    console.warn('[redis] Falling back to default in-memory Socket.IO operation.');
    isRedisConnected = false;
    return { isReady: false, error };
  }
}

/**
 * Checks if Redis is currently connected and active.
 */
export function isRedisActive() {
  return isRedisConnected && pubClient?.isOpen;
}

/**
 * Closes Redis connections during graceful shutdown.
 */
export async function closeRedis() {
  if (!isRedisConnected) return;

  try {
    await Promise.all([
      pubClient?.quit().catch(() => {}),
      subClient?.quit().catch(() => {}),
    ]);
    isRedisConnected = false;
    console.log('[redis] Redis connections closed.');
  } catch (err) {
    console.warn('[redis] Error closing Redis connections:', err.message);
  }
}

