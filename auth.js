// auth.js — password hashing (scrypt) and signed session tokens (HMAC).
// No external deps: everything here uses Node's built-in crypto module.
'use strict';
const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me-in-.env';
if (process.env.NODE_ENV !== 'test' && !process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set in .env — using an insecure default. Fine for local dev, not for production.');
}
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signToken(payload) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(b64, 'base64url').toString()); } catch (e) { return null; }
  if (!body.exp || body.exp < Date.now()) return null;
  return body;
}

/** Express middleware: requires a valid Bearer token, attaches req.userId/req.orgId.
 *  Role is looked up fresh from the DB on every request (not baked into the token),
 *  so a role change by an admin takes effect immediately without forcing a re-login. */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  const userRow = db.getUser(payload.uid);
  if (!userRow || userRow.org_id !== payload.orgId) return res.status(401).json({ error: 'Not authenticated' });
  if (userRow.status === 'suspended') return res.status(403).json({ error: 'Your account has been suspended. Contact your NGO admin.' });
  if (userRow.status === 'removed') return res.status(401).json({ error: 'This account no longer exists.' });
  req.userId = payload.uid;
  req.orgId = payload.orgId;
  next();
}

/** Express middleware factory: call after requireAuth. Looks up the user's current
 *  role and 403s if it isn't one of the allowed roles. Usage: requireRole('admin') */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const user = db.getUser(req.userId);
    if (!user || user.org_id !== req.orgId) return res.status(401).json({ error: 'Not authenticated' });
    req.role = user.role;
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: `This action needs the ${allowedRoles.join(' or ')} role.` });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth, requireRole };
