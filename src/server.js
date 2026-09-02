/**
 * Main server entry point.
 * Run with: npm run dev  (or: npm start)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const taskRoutes = require('./routes/tasks');

const app = express();

app.use(cors());
app.use(express.json());

// Simple health check - confirms the server is running at all,
// no login required. Good first thing to test in a browser.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'CRM backend is running.' });
});

app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);

// Catch-all error handler (keeps the server from crashing on unexpected errors)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`CRM backend listening on http://localhost:${PORT}`);
});
