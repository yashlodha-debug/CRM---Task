const express = require('express');
const router = express.Router();
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// Any logged-in user can see the list of active team members - needed
// to populate the "Assigned" dropdown when creating/editing a task.
// This is not sensitive data (just names), so no special permission
// beyond being logged in is required.
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `select id, username, full_name, role
       from users
       where is_active = true
       order by full_name asc`
    );
    res.json(rows);
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

module.exports = router;
