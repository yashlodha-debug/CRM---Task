/**
 * Auth service: the actual business logic behind logging in.
 * Kept separate from the route file so it's easy to test and reuse.
 */
const { query } = require('../db/pool');
const { comparePassword } = require('../utils/password');
const { signToken } = require('../utils/jwt');
const { todayIST } = require('../utils/date');
const crypto = require('crypto');

/**
 * Attempts to log a user in.
 * On success: creates a login_sessions row and returns a signed JWT.
 * On failure: throws an Error with a safe, generic message (we never reveal
 * whether the username or the password was wrong — that's a security best
 * practice, it stops attackers from guessing which usernames exist).
 */
async function login(username, password, ipAddress) {
  const { rows } = await query('select * from users where username = $1', [username]);
  const user = rows[0];

  if (!user || !user.is_active) {
    throw new Error('Invalid username or password.');
  }

  const passwordMatches = await comparePassword(password, user.password_hash);
  if (!passwordMatches) {
    throw new Error('Invalid username or password.');
  }

  // Close any session left open for this user - e.g. their token expired
  // and they're logging back in without ever having explicitly logged
  // out, or they're logging in again from another tab/device. Without
  // this, the old session stays "open" forever, overlapping in time with
  // the new one, and every working-time calculation that sums elapsed
  // time across today's sessions ends up double- or triple-counting the
  // overlap - hours worked can end up exceeding hours actually elapsed.
  // Any break still open under that stale session is closed too, same
  // fix as the day-end and break-limit sweeps.
  const { rows: staleSessions } = await query(
    `select id from login_sessions where user_id = $1 and logout_time is null`,
    [user.id]
  );
  for (const stale of staleSessions) {
    await query(
      `update break_logs
       set break_end = now(), duration_seconds = extract(epoch from (now() - break_start))::int
       where login_session_id = $1 and break_end is null`,
      [stale.id]
    );
    await query(
      `update login_sessions set logout_time = now(), logout_reason = 'expired' where id = $1`,
      [stale.id]
    );
  }

  // Issue the JWT first so we can store a hash of it (never the raw token)
  const token = signToken({ userId: user.id, role: user.role });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const loginDateIST = todayIST();

  const { rows: sessionRows } = await query(
    `insert into login_sessions (user_id, session_token_hash, ip_address, login_date_ist)
     values ($1, $2, $3, $4)
     returning id`,
    [user.id, tokenHash, ipAddress || null, loginDateIST]
  );

  return {
    token,
    loginSessionId: sessionRows[0].id,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role
    }
  };
}

/**
 * Ends a login session (manual logout). Also closes any break still left
 * open under it first - same fix applied to force-logout and the sweep
 * jobs, so a forgotten break can never survive past its own login
 * session, no matter which of the four ways that session ends.
 */
async function logout(loginSessionId) {
  await query(
    `update break_logs
     set break_end = now(), duration_seconds = extract(epoch from (now() - break_start))::int
     where login_session_id = $1 and break_end is null`,
    [loginSessionId]
  );
  await query(
    `update login_sessions
     set logout_time = now(), logout_reason = 'manual'
     where id = $1 and logout_time is null`,
    [loginSessionId]
  );
}

module.exports = { login, logout };