const express = require('express');
const router = express.Router();
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// Any logged-in user can read the active dropdown values - needed to
// populate Task/Related To/Exis Data selects on the New Task form etc.
// Editing these values is Master-only (see routes/admin.js).
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `select field_name, value, sort_order
       from dropdown_options
       where is_active = true
       order by field_name asc, sort_order asc, value asc`
    );
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.field_name]) grouped[row.field_name] = [];
      grouped[row.field_name].push(row.value);
    }
    res.json(grouped);
  } catch (err) {
    console.error('List dropdowns error:', err);
    res.status(500).json({ error: 'Failed to load dropdown options.' });
  }
});

module.exports = router;
