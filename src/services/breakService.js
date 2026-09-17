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
/**
 * Item 2: force-logs-out anyone who has hit today's break limit. This
 * should only take effect ONCE per user per day - after the enforced
 * logout, they must be able to log back in and keep working normally
 * for the rest of the day, even though their cumulative break time for
 * today is still technically over the limit. Without the "not already
 * enforced today" check below, this sweep (which runs every minute)
 * would see that same over-the-limit total on every subsequent login
 * and immediately force them back out again within a minute - making
 * the limit effectively lock them out for the rest of the day, which is
 * not the intended behavior.
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
            ), 0) >= $2
       and not exists (
         select 1 from login_sessions ls
         where ls.user_id = bl.user_id
           and ls.login_date_ist = $1
           and ls.logout_reason = 'break_limit'
       )`,
    [today, limitSeconds]
  );

  let closedCount = 0;
  for (const row of rows) {
    // Close any break still open under today's active session first -
    // same fix as the day-end sweep, otherwise it's left open forever.
    await query(
      `update break_logs bl
       set break_end = now(), duration_seconds = extract(epoch from (now() - bl.break_start))::int
       from login_sessions ls
       where bl.login_session_id = ls.id
         and bl.break_end is null
         and ls.user_id = $1
         and ls.login_date_ist = $2`,
      [row.user_id, today]
    );

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
/**
 * Closes any login session that's rolled over from a previous IST day
 * (a safety net cron sweep - normally sessions end via explicit
 * logout/break-limit). Also closes any break still left open under one
 * of those sessions: if someone forgot to end a break before this ran,
 * their break_logs row would otherwise stay open forever - break_end
 * never getting set - which then silently excludes it from every future
 * day's "breaks today" / "total break time today" totals while still
 * showing up as "currently on break" indefinitely. Closing it here,
 * timestamped to when the sweep actually runs, fixes both.
 */
async function sweepDayEnd() {
  const today = todayIST();

  const { rows: closedBreaks } = await query(
    `update break_logs bl
     set break_end = now(), duration_seconds = extract(epoch from (now() - bl.break_start))::int
     from login_sessions ls
     where bl.login_session_id = ls.id
       and bl.break_end is null
       and ls.login_date_ist != $1
     returning bl.id`,
    [today]
  );

  const { rows } = await query(
    `update login_sessions
     set logout_time = now(), logout_reason = 'day_end'
     where logout_time is null and login_date_ist != $1
     returning id`,
    [today]
  );

  if (closedBreaks.length > 0) {
    console.log(`Day-end sweep also closed ${closedBreaks.length} stale open break(s).`);
  }

  return rows.length;
}

async function adminEditBreak(breakId, updates) {
  const { rows: existingRows } = await query(`select * from break_logs where id = $1`, [breakId]);
  const existing = existingRows[0];
  if (!existing) {
    throw Object.assign(new Error('Break entry not found.'), { statusCode: 404 });
  }

  const fields = [];
  const values = [];
  let i = 1;

  if (updates.breakType !== undefined) {
    if (!['lunch', 'tea', 'short'].includes(updates.breakType)) {
      throw Object.assign(new Error('Invalid break type.'), { statusCode: 400 });
    }
    fields.push(`break_type = $${i++}`);
    values.push(updates.breakType);
  }
  if (updates.breakStart !== undefined) {
    fields.push(`break_start = $${i++}`);
    values.push(updates.breakStart);
  }
  if (updates.breakEnd !== undefined) {
    fields.push(`break_end = $${i++}`);
    values.push(updates.breakEnd);
  }
  if (fields.length === 0) {
    throw Object.assign(new Error('No fields to update.'), { statusCode: 400 });
  }

  const newStart = updates.breakStart !== undefined ? updates.breakStart : existing.break_start;
  const newEnd = updates.breakEnd !== undefined ? updates.breakEnd : existing.break_end;
  if (newEnd && new Date(newEnd) <= new Date(newStart)) {
    throw Object.assign(new Error('Break end must be after break start.'), { statusCode: 400 });
  }

  fields.push(`duration_seconds = $${i++}`);
  values.push(newEnd ? Math.round((new Date(newEnd) - new Date(newStart)) / 1000) : null);

  values.push(breakId);
  const { rows } = await query(
    `update break_logs set ${fields.join(', ')} where id = $${i} returning *`,
    values
  );
  return rows[0];
}

async function adminDeleteBreak(breakId) {
  const { rows } = await query(`delete from break_logs where id = $1 returning id`, [breakId]);
  if (rows.length === 0) {
    throw Object.assign(new Error('Break entry not found.'), { statusCode: 404 });
  }
  return { success: true };
}

/**
 * Ends a break immediately, without touching the user's login session -
 * they stay logged in and simply return to "working" status. (Previously
 * this always force-logged the user out too; that's now a separate,
 * explicit action - see adminForceLogoutUser - so Master can choose
 * exactly which one they want from the Team Breaks dropdown.)
 */
async function adminForceEndBreak(breakId) {
  const { rows: breakRows } = await query(
    `update break_logs
     set break_end = now(),
         duration_seconds = extract(epoch from (now() - break_start))::int
     where id = $1 and break_end is null
     returning *`,
    [breakId]
  );
  const brk = breakRows[0];
  if (!brk) {
    throw Object.assign(new Error('This break is not currently active.'), { statusCode: 400 });
  }
  return { break: brk };
}

/**
 * Item 1: Master-triggered logout for a specific user's active session
 * today. Closes any break still open under that session first (so it's
 * never left dangling), then ends the session itself.
 */
async function adminForceLogoutUser(userId) {
  const today = todayIST();

  return withTransaction(async (client) => {
    await client.query(
      `update break_logs bl
       set break_end = now(), duration_seconds = extract(epoch from (now() - bl.break_start))::int
       from login_sessions ls
       where bl.login_session_id = ls.id
         and bl.break_end is null
         and ls.user_id = $1
         and ls.login_date_ist = $2`,
      [userId, today]
    );

    const { rows: closed } = await client.query(
      `update login_sessions
       set logout_time = now(), logout_reason = 'master_forced'
       where user_id = $1 and login_date_ist = $2 and logout_time is null
       returning id`,
      [userId, today]
    );

    if (closed.length === 0) {
      throw Object.assign(new Error('This user is not currently logged in.'), { statusCode: 400 });
    }

    return { success: true, sessionsClosed: closed.length };
  });
}

async function getTeamBreakSummary() {
  const today = todayIST();

  // break_logs and login_sessions are aggregated separately first (each
  // as one row per user), then joined - joining the two raw tables
  // directly would fan out into a cross product (every break row paired
  // with every login row for that user), silently multiplying the break
  // counts and totals. Aggregating first avoids that entirely.
  const { rows: totals } = await query(
    `with break_agg as (
       select user_id,
              count(*) filter (where date_ist = $1) as breaks_today,
              coalesce(sum(
                case when date_ist = $1 then
                  case when break_end is not null then duration_seconds
                       else extract(epoch from (now() - break_start))::int
                  end
                else 0 end
              ), 0) as total_break_seconds_today
       from break_logs
       group by user_id
     ),
     login_agg as (
       select user_id, min(login_time) as first_login_today
       from login_sessions
       where login_date_ist = $1
       group by user_id
     )
     select
       u.id as user_id,
       u.full_name,
       u.username,
       coalesce(break_agg.breaks_today, 0) as breaks_today,
       coalesce(break_agg.total_break_seconds_today, 0) as total_break_seconds_today,
       login_agg.first_login_today
     from users u
     left join break_agg on break_agg.user_id = u.id
     left join login_agg on login_agg.user_id = u.id
     where u.role != 'master'
     order by u.full_name asc`,
    [today]
  );

  const { rows: openBreaks } = await query(
    `select id, user_id, break_type, break_start
     from break_logs
     where break_end is null`
  );
  const openByUser = new Map(openBreaks.map((b) => [b.user_id, b]));

  // Separate from "loggedInToday" (which just means they logged in at
  // some point today, even if since logged out) - this tells the
  // frontend whether there's a session open RIGHT NOW, which decides
  // whether "Force logout" makes sense to offer.
  const { rows: activeSessions } = await query(
    `select user_id from login_sessions where login_date_ist = $1 and logout_time is null`,
    [today]
  );
  const activeUserIds = new Set(activeSessions.map((s) => s.user_id));

  return totals.map((row) => {
    const open = openByUser.get(row.user_id);
    return {
      userId: row.user_id,
      fullName: row.full_name,
      username: row.username,
      firstLoginToday: row.first_login_today,
      loggedInToday: Boolean(row.first_login_today),
      isCurrentlyLoggedIn: activeUserIds.has(row.user_id),
      breaksToday: Number(row.breaks_today),
      totalBreakSecondsToday: Number(row.total_break_seconds_today),
      onBreak: Boolean(open),
      currentBreak: open || null
    };
  });
}

/**
 * Item 4: date-wise attendance report for Master to export. Builds a
 * full grid of every active date x every non-master user in the range
 * (using generate_series), so absent days show up as "Not Available"
 * rather than being silently missing from the report - the whole point
 * is to be able to check attendance for each user for each day, not
 * just see days someone happened to log in.
 */
async function getAttendanceReport(startDate, endDate) {
  const { rows } = await query(
    `select
       d::date as date,
       u.id as user_id,
       u.full_name,
       la.first_login,
       coalesce(ba.breaks_count, 0) as breaks_count,
       coalesce(ba.total_break_seconds, 0) as total_break_seconds
     from generate_series($1::date, $2::date, interval '1 day') as d
     cross join users u
     left join (
       select user_id, login_date_ist, min(login_time) as first_login
       from login_sessions
       where login_date_ist between $1 and $2
       group by user_id, login_date_ist
     ) la on la.user_id = u.id and la.login_date_ist = d::date
     left join (
       select user_id, date_ist,
              count(*) as breaks_count,
              sum(
                case when break_end is not null then duration_seconds
                     else extract(epoch from (now() - break_start))::int
                end
              ) as total_break_seconds
       from break_logs
       where date_ist between $1 and $2
       group by user_id, date_ist
     ) ba on ba.user_id = u.id and ba.date_ist = d::date
     where u.role != 'master'
     order by d asc, u.full_name asc`,
    [startDate, endDate]
  );

  return rows.map((row) => ({
    date: row.date,
    fullName: row.full_name,
    loginTime: row.first_login,
    status: row.first_login ? 'Logged In' : 'Not Available',
    breaksCount: Number(row.breaks_count),
    totalBreakSeconds: Number(row.total_break_seconds)
  }));
}

module.exports = {
  startBreak,
  endBreak,
  getStatus,
  sweepBreakLimitViolations,
  sweepDayEnd,
  breakLimitSeconds,
  adminEditBreak,
  adminDeleteBreak,
  adminForceEndBreak,
  adminForceLogoutUser,
  getTeamBreakSummary,
  getAttendanceReport
};
