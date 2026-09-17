const breakService = require('../services/breakService');
const express = require('express');
const router = express.Router();
const adminService = require('../services/adminService');
const dropdownService = require('../services/dropdownService');
const activityService = require('../services/activityService');
const { authenticate } = require('../middleware/auth');
const { requireMaster } = require('../middleware/permissions');
const { todayIST } = require('../utils/date');

// Every route here is Master-only, regardless of individual permissions -
// user management and permission editing are always Master's job.
router.use(authenticate);
router.use(requireMaster);

/** GET /api/admin/users - full user list, including disabled accounts. */
router.get('/users', async (req, res) => {
  try {
    const users = await adminService.listAllUsers();
    res.json(users);
  } catch (err) {
    console.error('List all users error:', err);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

/** POST /api/admin/users - create a new user. Body: { username, password, fullName, role } */
router.post('/users', async (req, res) => {
  try {
    const user = await adminService.createUser(req.body);
    res.status(201).json(user);
  } catch (err) {
    console.error('Create user error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create user.' });
  }
});

/** PATCH /api/admin/users/:id/active - enable/disable a user. Body: { isActive } */
router.patch('/users/:id/active', async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive (true/false) is required.' });
    }
    const user = await adminService.setUserActive(req.params.id, isActive);
    res.json(user);
  } catch (err) {
    console.error('Set user active error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to update user.' });
  }
});

/** PATCH /api/admin/users/:id/password - reset a user's password. Body: { newPassword } */
router.patch('/users/:id/password', async (req, res) => {
  try {
    const { newPassword } = req.body;
    const result = await adminService.resetUserPassword(req.params.id, newPassword);
    res.json(result);
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to reset password.' });
  }
});

/** GET /api/admin/users/:id/permissions - every permission + whether it's on for this user. */
router.get('/users/:id/permissions', async (req, res) => {
  try {
    const permissions = await adminService.getUserPermissions(req.params.id);
    res.json(permissions);
  } catch (err) {
    console.error('Get user permissions error:', err);
    res.status(500).json({ error: 'Failed to load permissions.' });
  }
});

/** PATCH /api/admin/users/:id/permissions - toggle one permission. Body: { permissionKey, enabled } */
router.patch('/users/:id/permissions', async (req, res) => {
  try {
    const { permissionKey, enabled } = req.body;
    if (!permissionKey || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'permissionKey and enabled (true/false) are required.' });
    }
    const permissions = await adminService.setUserPermission(req.params.id, permissionKey, enabled, req.user.id);
    res.json(permissions);
  } catch (err) {
    console.error('Set user permission error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to update permission.' });
  }
});

/**
 * Dropdown Management (Item 3) - lets Master manage every dropdown's
 * values (Assigned, Task, Related To, Exis Data, Status, Dashboard
 * Status) without ever touching the database directly.
 */

/** GET /api/admin/dropdowns - every option, across all fields. */
router.get('/dropdowns', async (req, res) => {
  try {
    const options = await dropdownService.listAll();
    res.json(options);
  } catch (err) {
    console.error('List dropdown options error:', err);
    res.status(500).json({ error: 'Failed to load dropdown options.' });
  }
});

/** POST /api/admin/dropdowns - add a new option. Body: { fieldName, value, sortOrder } */
router.post('/dropdowns', async (req, res) => {
  try {
    const option = await dropdownService.createOption(req.body);
    res.status(201).json(option);
  } catch (err) {
    console.error('Create dropdown option error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create option.' });
  }
});

/** PATCH /api/admin/dropdowns/:id - edit an option. Body: { value?, sortOrder?, isActive? } */
router.patch('/dropdowns/:id', async (req, res) => {
  try {
    const option = await dropdownService.updateOption(req.params.id, req.body);
    res.json(option);
  } catch (err) {
    console.error('Update dropdown option error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to update option.' });
  }
});

/** DELETE /api/admin/dropdowns/:id - permanently remove an option. */
router.delete('/dropdowns/:id', async (req, res) => {
  try {
    const result = await dropdownService.deleteOption(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Delete dropdown option error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to delete option.' });
  }
});

/**
 * GET /api/admin/users/:id/activity
 * Item 3: complete login/logout/break history for one user, for Master
 * to review - first login ever, every session, and every break within
 * each session, plus running totals.
 */
router.get('/users/:id/activity', async (req, res) => {
  try {
    const history = await activityService.getUserActivityHistory(req.params.id);
    res.json(history);
  } catch (err) {
    console.error('Get user activity error:', err);
    res.status(500).json({ error: 'Failed to load activity history.' });
  }
});

/** PATCH /api/admin/breaks/:id - edit type/timestamps of a break entry. */
router.patch('/breaks/:id', async (req, res) => {
  try {
    const updated = await breakService.adminEditBreak(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    console.error('Edit break error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to edit break.' });
  }
});

/** DELETE /api/admin/breaks/:id - remove an incorrect break entry. */
router.delete('/breaks/:id', async (req, res) => {
  try {
    const result = await breakService.adminDeleteBreak(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Delete break error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to delete break.' });
  }
});

/** POST /api/admin/breaks/:id/end - end a break, without logging the user out. */
router.post('/breaks/:id/end', async (req, res) => {
  try {
    const result = await breakService.adminForceEndBreak(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Force end break error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to end break.' });
  }
});

/**
 * POST /api/admin/users/:id/force-logout
 * Item 1: Master-triggered logout for the Team Breaks dropdown. Closes
 * any break still open under the user's active session first.
 */
router.post('/users/:id/force-logout', async (req, res) => {
  try {
    const result = await breakService.adminForceLogoutUser(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Force logout error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to log user out.' });
  }
});

/**
 * POST /api/admin/users/:id/start-break
 * Item 2: Master starts a specific break type on a user's behalf, for
 * when they forgot to select one themselves.
 */
router.post('/users/:id/start-break', async (req, res) => {
  try {
    const { breakType } = req.body;
    const result = await breakService.adminStartBreakForUser(req.params.id, breakType);
    res.json(result);
  } catch (err) {
    console.error('Admin start break error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to start break.' });
  }
});

/**
 * GET /api/admin/breaks/today
 * Item 1: team-wide break overview - every non-Master user's break count
 * and total time today, plus whether they're currently on break.
 */
router.get('/breaks/today', async (req, res) => {
  try {
    const summary = await breakService.getTeamBreakSummary();
    res.json(summary);
  } catch (err) {
    console.error('Get team break summary error:', err);
    res.status(500).json({ error: 'Failed to load break summary.' });
  }
});

/**
 * GET /api/admin/attendance-report?start=YYYY-MM-DD&end=YYYY-MM-DD
 * Item 4: date-wise attendance export. Defaults to the last 30 days if
 * no range is given. Returns JSON rows - the frontend turns this into a
 * CSV file, since the browser's auth token can't be attached to a plain
 * download link.
 */
router.get('/attendance-report', async (req, res) => {
  try {
    const end = req.query.end || todayIST();
    const start = req.query.start || (() => {
      const d = new Date(end);
      d.setDate(d.getDate() - 29);
      return d.toISOString().slice(0, 10);
    })();

    const rows = await breakService.getAttendanceReport(start, end);
    res.json(rows);
  } catch (err) {
    console.error('Get attendance report error:', err);
    res.status(500).json({ error: 'Failed to load attendance report.' });
  }
});

module.exports = router;

