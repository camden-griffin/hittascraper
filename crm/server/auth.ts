import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { RequestHandler } from 'express';
import { db } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET env var is required');

const EXPIRES_IN = '7d';

export function hashPassword(plain: string) {
  return bcrypt.hashSync(plain, 10);
}

export function checkPassword(plain: string, hash: string) {
  return bcrypt.compareSync(plain, hash);
}

export function signToken(userId: number, email: string) {
  return jwt.sign({ sub: userId, email }, JWT_SECRET!, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): { sub: number; email: string } {
  return jwt.verify(token, JWT_SECRET!) as { sub: number; email: string };
}

// Express middleware — attaches req.user or returns 401
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    (req as any).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Seed a default user if the users table is empty.
// Change the credentials here (or set DEFAULT_EMAIL / DEFAULT_PASSWORD env vars) before first run.
export function seedDefaultUser() {
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  if (count > 0) return;
  const email = process.env.DEFAULT_EMAIL ?? 'admin@crm.local';
  const password = process.env.DEFAULT_PASSWORD ?? 'changeme';
  db.prepare('INSERT INTO users (email, password) VALUES (?, ?)').run(email, hashPassword(password));
  console.log(`[auth] Created default user: ${email}  password: ${password}`);
  console.log('[auth] Change DEFAULT_EMAIL / DEFAULT_PASSWORD in .env before going to production.');
}
