/**
 * Permission-checking middleware.
 *
 * Usage on a route:
 *   router.post('/tasks', authenticate, requirePermission('create_task'), handler)
 *
 * Master/Admin always passes (full access). Normal users are checked
 * against the user_permissions table — the same table Master edits from
 * the Permission Management screen, so access changes take effect
 * immediately without any code change or deploy.
 */
const { query } = require('../db/pool');

function requirePermission(permissionKey) {
  return async function (req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated.' });
      }

      if (req.user.role === 'master') {
        return next(); // Master bypasses all permission checks
      }

      const { rows } = await query(
        `select enabled from user_permissions where user_id = $1 and permission_key = $2`,
        [req.user.id, permissionKey]
      );

      const allowed = rows.length > 0 && rows[0].enabled === true;

      if (!allowed) {
        return res.status(403).json({
          error: `You don't have permission to do this (requires "${permissionKey}").`
        });
      }

      next();
    } catch (err) {
      console.error('Permission middleware error:', err);
      res.status(500).json({ error: 'Internal server error while checking permissions.' });
    }
  };
}

module.exports = { requirePermission };

/**
 * Simple role-gate for screens that are Master-only regardless of
 * individual permissions (e.g. the Sync Monitor, User Management).
 */
function requireMaster(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  if (req.user.role !== 'master') {
    return res.status(403).json({ error: 'Master access required.' });
  }
  next();
}

module.exports.requireMaster = requireMaster;
