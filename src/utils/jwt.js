/**
 * JWT (JSON Web Token) helpers.
 *
 * When a user logs in successfully, we hand them a signed token instead of
 * making them re-send their password on every request. The token proves
 * "this is user X" without the server needing to keep every session in
 * memory — it just verifies the signature using JWT_SECRET.
 *
 * We keep the token payload minimal (user id + role) — anything else
 * (permissions, name, etc.) should be looked up fresh from the database
 * on each request, not trusted from the token, in case it changes
 * (e.g. Master disables the user or changes their role mid-session).
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set in .env — the app cannot start without it.');
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws if invalid/expired
}

module.exports = { signToken, verifyToken };
