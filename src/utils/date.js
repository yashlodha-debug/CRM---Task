/**
 * Small helpers for the IST (Asia/Kolkata) day-boundary logic used by
 * login sessions, break limits, and daily auto-logout.
 */

/**
 * Returns today's date as YYYY-MM-DD in IST, regardless of the server's
 * own timezone (important since free hosting often runs servers in UTC).
 */
function todayIST() {
  const now = new Date();
  // en-CA locale formats as YYYY-MM-DD, which is what Postgres 'date' expects
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

module.exports = { todayIST };
