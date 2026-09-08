/**
 * Admin service: user creation/management and permission editing.
 * Every function here is only reachable via requireMaster-gated routes.
 */
const { query } = require('../db/pool');
const { hashPassword } = require('../utils/password');

async function listAllUsers() {
  const { rows } = await query(
    `select id, username, full_name, role, is_active, created_at
     from users
     order by full_name asc`
  );
  return rows;
}

async function createUser({ username, password, fullName, role }) {
  if (!username || !password || !fullName) {
    throw Object.assign(new Error('Username, password, and full name are required.'), { statusCode: 400 });
  }
  const finalRole = role === 'master' ? 'master' : 'user';

  const { rows: existing } = await query('select id from users where username = $1', [username]);
  if (existing.length > 0) {
    throw Object.assign(new Error('That username is already taken.'), { statusCode: 409 });
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `insert into users (username, password_hash, full_name, role, is_active)
     values ($1, $2, $3, $4, true)
     returning id, username, full_name, role, is_active, created_at`,
    [username, passwordHash, fullName, finalRole]
  );
  return rows[0];
}

async function setUserActive(userId, isActive) {
  const { rows } = await query(
    `update users set is_active = $1, updated_at = now() where id = $2
     returning id, username, full_name, role, is_active`,
    [isActive, userId]
  );
  if (rows.length === 0) {
    throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  }
  return rows[0];
}

async function resetUserPassword(userId, newPassword) {
  if (!newPassword || newPassword.length < 4) {
    throw Object.assign(new Error('Password must be at least 4 characters.'), { statusCode: 400 });
  }
  const passwordHash = await hashPassword(newPassword);
  const { rows } = await query(
    `update users set password_hash = $1, updated_at = now() where id = $2 returning id`,
    [passwordHash, userId]
  );
  if (rows.length === 0) {
    throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  }
  return { success: true };
}

/**
 * Returns every defined permission, each annotated with whether it's
 * currently enabled for this specific user - exactly what the Permission
 * Management screen needs to render a full set of toggles.
 */
async function getUserPermissions(userId) {
  const { rows } = await query(
    `select pd.key, pd.label, coalesce(up.enabled, false) as enabled
     from permission_definitions pd
     left join user_permissions up on up.permission_key = pd.key and up.user_id = $1
     order by pd.label asc`,
    [userId]
  );
  return rows;
}

/**
 * Sets one permission on/off for a user. Uses an upsert so it works
 * whether or not a row already exists for this user+permission pair.
 */
async function setUserPermission(userId, permissionKey, enabled, updatedByUserId) {
  const { rows: defRows } = await query('select key from permission_definitions where key = $1', [permissionKey]);
  if (defRows.length === 0) {
    throw Object.assign(new Error('Unknown permission key.'), { statusCode: 400 });
  }

  await query(
    `insert into user_permissions (user_id, permission_key, enabled, updated_by, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (user_id, permission_key)
     do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
    [userId, permissionKey, enabled, updatedByUserId]
  );

  return getUserPermissions(userId);
}

module.exports = {
  listAllUsers,
  createUser,
  setUserActive,
  resetUserPassword,
  getUserPermissions,
  setUserPermission
};
