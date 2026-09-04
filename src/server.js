/**
 * Main server entry point.
 * Run with: npm run dev  (or: npm start)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const authRoutes = require('./routes/auth');
const taskRoutes = require('./routes/tasks');
const userRoutes = require('./routes/users');
const breakRoutes = require('./routes/breaks');
const syncRoutes = require('./routes/sync');
const breakService = require('./services/breakService');
const syncWorker = require('./services/syncWorker');
const { isConfigured: sheetsConfigured } = require('./services/sheetsClient');

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
app.use('/api/users', userRoutes);
app.use('/api/breaks', breakRoutes);
app.use('/api/sync', syncRoutes);

// Catch-all error handler (keeps the server from crashing on unexpected errors)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`CRM backend listening on http://localhost:${PORT}`);
  console.log(
    sheetsConfigured()
      ? 'Google Sheets sync: configured, worker active.'
      : 'Google Sheets sync: not configured yet (set GOOGLE_* vars in .env to enable).'
  );
});

/**
 * Safety-net cron jobs (blueprint sections 20-21).
 * Run every minute: catches anyone who exceeded their break limit without
 * clicking Resume, and anyone whose login day has rolled over without a
 * new request coming in to trigger the reactive check in the auth
 * middleware. Neither of these is the primary enforcement mechanism -
 * they're a backstop so nothing depends solely on the user's next click.
 */
cron.schedule('* * * * *', async () => {
  try {
    const breakSwept = await breakService.sweepBreakLimitViolations();
    const daySwept = await breakService.sweepDayEnd();
    if (breakSwept > 0 || daySwept > 0) {
      console.log(`Cron sweep: ${breakSwept} break-limit logout(s), ${daySwept} day-end logout(s).`);
    }
  } catch (err) {
    console.error('Cron sweep error:', err);
  }
});

/**
 * Sync queue worker (blueprint section 10/24). Runs every 10 seconds -
 * frequent enough that changes show up in the sheet within moments, but
 * without hammering the Google Sheets API. Silently does nothing if
 * Google Sheets credentials haven't been configured yet.
 */
cron.schedule('*/10 * * * * *', async () => {
  try {
    await syncWorker.processQueue();
  } catch (err) {
    console.error('Sync worker error:', err);
  }
});
