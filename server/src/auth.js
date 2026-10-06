import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, findUserById, findUserByUsername } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'yt-watch-party-jwt-secret-key-2026';
const JWT_EXPIRES_IN = '7d';

export function hashPassword(plainTextPassword) {
  return bcrypt.hash(plainTextPassword, 10);
}

export function comparePassword(plainTextPassword, hash) {
  return bcrypt.compare(plainTextPassword, hash);
}

export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export const authRouter = express.Router();

/**
 * Register a new user
 * POST /api/auth/register
 * Body: { username, password, email? }
 */
authRouter.post('/register', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

  if (!username || username.length < 3 || username.length > 24) {
    return res.status(400).json({
      ok: false,
      error: 'Username must be between 3 and 24 characters long.',
    });
  }

  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.status(400).json({
      ok: false,
      error: 'Username can only contain letters, numbers, underscores, dots and hyphens.',
    });
  }

  if (!password || password.length < 4) {
    return res.status(400).json({
      ok: false,
      error: 'Password must be at least 4 characters long.',
    });
  }

  try {
    const existing = await findUserByUsername(username);
    if (existing) {
      return res.status(409).json({
        ok: false,
        error: 'That username is already taken. Please choose another.',
      });
    }

    const hashedPassword = await hashPassword(password);
    const user = await createUser({ username, password: hashedPassword, email });
    const token = generateToken(user);

    return res.status(201).json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
      token,
    });
  } catch (err) {
    console.error('[auth] Register error:', err.message);
    if (err.message === 'USERNAME_TAKEN') {
      return res.status(409).json({
        ok: false,
        error: 'That username is already taken.',
      });
    }
    return res.status(500).json({
      ok: false,
      error: 'Registration failed. Please try again.',
    });
  }
});

/**
 * Log in an existing user
 * POST /api/auth/login
 * Body: { username, password }
 */
authRouter.post('/login', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      error: 'Please provide both username and password.',
    });
  }

  try {
    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid username or password.',
      });
    }

    const matches = await comparePassword(password, user.password);
    if (!matches) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid username or password.',
      });
    }

    const token = generateToken(user);

    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
      token,
    });
  } catch (err) {
    console.error('[auth] Login error:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'Login failed. Please try again.',
    });
  }
});

/**
 * Check current logged in user
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 */
authRouter.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }

  const token = authHeader.slice(7).trim();
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ ok: false, error: 'Session expired or invalid token' });
  }

  try {
    const user = await findUserById(decoded.id);
    if (!user) {
      // Fallback to decoded payload in in-memory mode
      return res.json({
        ok: true,
        user: {
          id: decoded.id,
          username: decoded.username,
        },
      });
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (err) {
    console.error('[auth] Me error:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not fetch user profile.' });
  }
});

