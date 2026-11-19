import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.ts';

const JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET !== 'CHANGE_ME_IN_PRODUCTION'
    ? process.env.JWT_SECRET
    : crypto.createHash('sha256').update(process.cwd() + '_autopatch_dev_secret').digest('hex');

const ACCESS_EXPIRY = '2h';
const REFRESH_EXPIRY_DAYS = 7;

export interface AuthenticatedUser {
  id: number;
  email: string;
  full_name: string;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many authentication attempts. Please wait a few minutes and try again.' },
});

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateAccessToken(user: AuthenticatedUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRY }
  );
}

export function createRefreshToken(userId: number): string {
  const raw = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`
  ).run(userId, tokenHash, expiresAt);
  return raw;
}

export function revokeRefreshToken(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?`).run(tokenHash);
}

export function verifyRefreshToken(rawToken: string): number | null {
  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare(
      `SELECT user_id, revoked, expires_at FROM refresh_tokens WHERE token_hash = ?`
    )
    .get(tokenHash) as { user_id: number; revoked: number; expires_at: string } | undefined;
  if (!row || row.revoked === 1) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}

export function verifyAccessToken(token: string): AuthenticatedUser | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as unknown as {
      sub: number;
      email: string;
      full_name: string;
    };
    const user = db
      .prepare(`SELECT id, email, full_name FROM users WHERE id = ?`)
      .get(payload.sub) as AuthenticatedUser | undefined;
    return user ?? null;
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }

  const token = header.slice(7).trim();
  const user = verifyAccessToken(token);
  if (!user) {
    res.status(401).json({ error: 'Session expired or invalid token. Please sign in again.' });
    return;
  }
  req.user = user;
  next();
}
