/**
 * Authentication middleware.
 *
 * Runs before any protected route. Checks:
 *   1. Is there a valid, non-expired token?
 *   2. Is the underlying login_sessions row still open (not logged out,
 *      not expired for break-limit/day-end reasons)?
 *   3. Is the user still active (Master hasn't disabled them)?
 *
 * If all pass, attaches req.user = { id, username, role } so every
 * later route/middleware can trust who's making the request.
 */
const { verifyToken } = require('../utils/jwt');
const { query } = require('../db/pool');
const { todayIST } = require('../utils/date');
const crypto = require('crypto');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'No token provided. Please log in.' });
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const { rows } = await query(
      `select ls.id as login_session_id, ls.logout_time,
              ls.login_date_ist::text as login_date_ist,
              u.id, u.username, u.full_name, u.role, u.is_active
       from login_sessions ls
       join users u on u.id = ls.user_id
       where ls.session_token_hash = $1`,
      [tokenHash]
    );

    const record = rows[0];

    if (!record) {
      return res.status(401).json({ error: 'Session not found. Please log in again.' });
    }
    if (record.logout_time) {
      return res.status(401).json({ error: 'Session has ended. Please log in again.' });
    }
    if (!record.is_active) {
      return res.status(403).json({ error: 'Your account has been disabled. Contact your Master/Admin.' });
    }
    // Daily auto-logout safety net: if this session's login day isn't today (IST),
    // force it closed even if the nightly cron job hasn't run yet.
    if (record.login_date_ist !== todayIST()) {
      await query(
        `update login_sessions set logout_time = now(), logout_reason = 'day_end' where id = $1`,
        [record.login_session_id]
      );
      return res.status(401).json({ error: 'Your session expired at the end of the day. Please log in again.' });
    }

    req.user = {
      id: record.id,
      username: record.username,
      fullName: record.full_name,
      role: record.role
    };
    req.loginSessionId = record.login_session_id;

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Internal server error during authentication.' });
  }
}

module.exports = { authenticate };
