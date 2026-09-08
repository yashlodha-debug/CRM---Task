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

  // Enforced here (not just as a disabled button in the UI) - a task
  // actively "Working On" must be paused/finished before starting a
  // break, otherwise its time-tracking clock would keep running while
  // the person is genuinely away.
  const { rows: workingRows } = await query(
    `select count(*)::int as count from tasks where assigned_user_id = $1 and status = 'Working On'`,
    [userId]
  );
  if (workingRows[0].count > 0) {
    throw Object.assign(
      new Error('You have a task marked "Working On". Pause or finish it before taking a break.'),
      { statusCode: 409 }
    );
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
 * their daily break limit - scoped to the whole calendar day across ALL
 * of the user's login sessions today, not just this one session. (If
 * scoped per-session, someone could reset their break allowance simply
 * by logging out and back in - not the intended "55 minutes per day".)
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
       where user_id = $1 and date_ist = $2 and duration_seconds is not null`,
      [userId, todayIST()]
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
     where user_id = $1 and date_ist = $2 and duration_seconds is not null`,
    [userId, todayIST()]
  );

  return {
    onBreak: openBreak.length > 0,
    currentBreak: openBreak[0] || null,
    totalBreakSeconds: Number(totalRows[0].total),
    breakLimitSeconds: breakLimitSeconds()
  };
}

/**
 * Safety-net sweep: called by the cron job. Finds every user whose
 * accumulated break time today (across all their login sessions, plus
 * any break still open) has reached the daily limit, and force-logs-out
 * every open session they currently have.
 */
async function sweepBreakLimitViolations() {
  const limitSeconds = breakLimitSeconds();
  const today = todayIST();

  const { rows } = await query(
    `select bl.user_id,
            coalesce(sum(
              case when bl.break_end is not null then bl.duration_seconds
                   else extract(epoch from (now() - bl.break_start))::int
              end
            ), 0) as total_break_seconds
     from break_logs bl
     where bl.date_ist = $1
     group by bl.user_id
     having coalesce(sum(
              case when bl.break_end is not null then bl.duration_seconds
                   else extract(epoch from (now() - bl.break_start))::int
              end
            ), 0) >= $2`,
    [today, limitSeconds]
  );

  let closedCount = 0;
  for (const row of rows) {
    const { rows: closed } = await query(
      `update login_sessions
       set logout_time = now(), logout_reason = 'break_limit'
       where user_id = $1 and logout_time is null and login_date_ist = $2
       returning id`,
      [row.user_id, today]
    );
    closedCount += closed.length;
  }

  return closedCount;
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
