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
 * Ends a login session (manual logout).
 */
async function logout(loginSessionId) {
  await query(
    `update login_sessions
     set logout_time = now(), logout_reason = 'manual'
     where id = $1 and logout_time is null`,
    [loginSessionId]
  );
}

module.exports = { login, logout };
