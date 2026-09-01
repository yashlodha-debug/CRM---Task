const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { authenticate } = require('../middleware/auth');
const { query } = require('../db/pool');

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Returns: { token, user }
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const result = await authService.login(username, password, ipAddress);

    res.json(result);
  } catch (err) {
    // authService throws a safe, generic message on bad credentials
    res.status(401).json({ error: err.message || 'Login failed.' });
  }
});

/**
 * POST /api/auth/logout
 * Requires a valid token. Ends the current login session.
 */
router.post('/logout', authenticate, async (req, res) => {
  try {
    await authService.logout(req.loginSessionId);
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to log out.' });
  }
});

/**
 * GET /api/auth/me
 * Requires a valid token. Returns the current user's info + their
 * enabled permissions, so the frontend knows what to show/hide.
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    let permissions = [];

    if (req.user.role === 'master') {
      // Master implicitly has every permission
      const { rows } = await query('select key from permission_definitions');
      permissions = rows.map(r => r.key);
    } else {
      const { rows } = await query(
        `select permission_key from user_permissions where user_id = $1 and enabled = true`,
        [req.user.id]
      );
      permissions = rows.map(r => r.permission_key);
    }

    res.json({ user: req.user, permissions });
  } catch (err) {
    console.error('/me error:', err);
    res.status(500).json({ error: 'Failed to load user info.' });
  }
});

module.exports = router;
