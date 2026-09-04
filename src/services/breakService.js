/**
 * Break tracking service.
 *
 * Two layers of enforcement for the daily break limit (blueprint sections
 * 19-20), matching the "reactive + safety net" design:
 *   1. Reactive: checked here, every time a break ends (endBreak).
 *   2. Safety net: a cron job (see server.js) independently re-checks all
 *      open sessions every minute, in case someone never clicks "Resume".
 */
const { query, withTransaction } = require('../db/pool');
const { todayIST } = require('../utils/date');

function breakLimitSeconds() {
  const minutes = Number(process.env.BREAK_LIMIT_MINUTES || 55);
  return Math.round(minutes * 60);
}

async function startBreak(userId, loginSessionId, breakType) {
  const validTypes = ['lunch', 'tea', 'short'];
  if (!validTypes.includes(breakType)) {
    throw Object.assign(new Error('Invalid break type.'), { statusCode: 400 });
  }

  const { rows } = await query(
    `insert into break_logs (user_id, login_session_id, break_type, date_ist)
     values ($1, $2, $3, $4)
     returning *`,
    [userId, loginSessionId, breakType, todayIST()]
  );
  return rows[0];
}

/**
 * Ends the current break, and checks whether the user has now exceeded
 * their daily break limit. If so, force-logs-out the session immediately
 * and reports that back to the caller so the frontend can react.
 */
async function endBreak(userId, loginSessionId) {
  return withTransaction(async (client) => {
    const { rows: openRows } = await client.query(
      `update break_logs
       set break_end = now(),
           duration_seconds = extract(epoch from (now() - break_start))::int
       where login_session_id = $1 and break_end is null
       returning *`,
      [loginSessionId]
    );

    if (openRows.length === 0) {
      throw Object.assign(new Error('No active break to end.'), { statusCode: 400 });
    }

    const { rows: totalRows } = await client.query(
      `select coalesce(sum(duration_seconds), 0) as total
       from break_logs
       where login_session_id = $1 and date_ist = $2 and duration_seconds is not null`,
      [loginSessionId, todayIST()]
    );
    const totalBreakSeconds = Number(totalRows[0].total);

    let loggedOut = false;
    if (totalBreakSeconds >= breakLimitSeconds()) {
      await client.query(
        `update login_sessions
         set logout_time = now(), logout_reason = 'break_limit'
         where id = $1 and logout_time is null`,
        [loginSessionId]
      );
      loggedOut = true;
    }

    return { break: openRows[0], totalBreakSeconds, loggedOut };
  });
}

async function getStatus(userId, loginSessionId) {
  const { rows: openBreak } = await query(
    `select * from break_logs where login_session_id = $1 and break_end is null`,
    [loginSessionId]
  );

  const { rows: totalRows } = await query(
    `select coalesce(sum(duration_seconds), 0) as total
     from break_logs
     where login_session_id = $1 and date_ist = $2 and duration_seconds is not null`,
    [loginSessionId, todayIST()]
  );

  return {
    onBreak: openBreak.length > 0,
    currentBreak: openBreak[0] || null,
    totalBreakSeconds: Number(totalRows[0].total),
    breakLimitSeconds: breakLimitSeconds()
  };
}

/**
 * Safety-net sweep: called by the cron job. Finds every still-open login
 * session whose accumulated break time today has reached the limit, and
 * force-logs them out - covers the case where a user never clicks Resume.
 */
async function sweepBreakLimitViolations() {
  const limitSeconds = breakLimitSeconds();
  const today = todayIST();

  // Counts completed breaks normally, and for any break still open,
  // counts its elapsed time so far - otherwise someone who starts a
  // break and simply never clicks Resume would never get caught here,
  // only on their next unrelated request (if any).
  const { rows } = await query(
    `select ls.id as login_session_id,
            coalesce(sum(
              case when bl.break_end is not null then bl.duration_seconds
                   else extract(epoch from (now() - bl.break_start))::int
              end
            ), 0) as total_break_seconds
     from login_sessions ls
     left join break_logs bl
       on bl.login_session_id = ls.id and bl.date_ist = $1
     where ls.logout_time is null and ls.login_date_ist = $1
     group by ls.id
     having coalesce(sum(
              case when bl.break_end is not null then bl.duration_seconds
                   else extract(epoch from (now() - bl.break_start))::int
              end
            ), 0) >= $2`,
    [today, limitSeconds]
  );

  for (const row of rows) {
    await query(
      `update login_sessions
       set logout_time = now(), logout_reason = 'break_limit'
       where id = $1 and logout_time is null`,
      [row.login_session_id]
    );
  }

  return rows.length;
}

/**
 * Daily auto-logout sweep (blueprint section 21): closes any login session
 * whose login_date_ist is not today, as a proactive safety net alongside
 * the reactive check already in the auth middleware.
 */
async function sweepDayEnd() {
  const today = todayIST();
  const { rows } = await query(
    `update login_sessions
     set logout_time = now(), logout_reason = 'day_end'
     where logout_time is null and login_date_ist != $1
     returning id`,
    [today]
  );
  return rows.length;
}

module.exports = { startBreak, endBreak, getStatus, sweepBreakLimitViolations, sweepDayEnd, breakLimitSeconds };
