const express = require('express');
const router = express.Router();
const breakService = require('../services/breakService');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

/**
 * POST /api/breaks/start
 * Body: { breakType: 'lunch' | 'tea' | 'short' }
 */
router.post('/start', async (req, res) => {
  try {
    const { breakType } = req.body;
    const result = await breakService.startBreak(req.user.id, req.loginSessionId, breakType);
    res.status(201).json(result);
  } catch (err) {
    console.error('Start break error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to start break.' });
  }
});

/**
 * POST /api/breaks/end
 * Ends the current break. If this pushes the user's total break time for
 * today past the limit, their session is force-logged-out and the
 * response reflects that (loggedOut: true) so the frontend can redirect.
 */
router.post('/end', async (req, res) => {
  try {
    const result = await breakService.endBreak(req.user.id, req.loginSessionId);
    res.json(result);
  } catch (err) {
    console.error('End break error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to end break.' });
  }
});

/**
 * GET /api/breaks/status
 * Current break state + running total for today - used to render the
 * break widget and the "Total Break Time" stat on the dashboard.
 */
router.get('/status', async (req, res) => {
  try {
    const status = await breakService.getStatus(req.user.id, req.loginSessionId);
    res.json(status);
  } catch (err) {
    console.error('Break status error:', err);
    res.status(500).json({ error: 'Failed to load break status.' });
  }
});

module.exports = router;
