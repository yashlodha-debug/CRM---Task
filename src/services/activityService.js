/**
 * Activity service: aggregates login_sessions + break_logs into the
 * numbers the dashboard (Item 5/6) and the Master's activity history
 * screen (Item 3) actually need.
 */
const { query } = require('../db/pool');
const { todayIST } = require('../utils/date');

/**
 * Item 6: "Today's Total Working Time" - correctly aggregated across
 * every login session the user has had today (not just the current one),
 * so logging out for lunch and back in doesn't reset the count. Working
 * time = time logged in, minus break time, summed across all of today's
 * sessions.
 */
async function getTodayWorkingSummary(userId, currentLoginSessionId) {
  const today = todayIST();

  const { rows: sessions } = await query(
    `select id, login_time, logout_time
     from login_sessions
     where user_id = $1 and login_date_ist = $2
     order by login_time asc`,
    [userId, today]
  );

  const firstLoginTime = sessions.length > 0 ? sessions[0].login_time : null;

  const { rows: totalElapsedRows } = await query(
    `select coalesce(sum(extract(epoch from (coalesce(logout_time, now()) - login_time))), 0) as total
     from login_sessions
     where user_id = $1 and login_date_ist = $2`,
    [userId, today]
  );
  const totalElapsedSeconds = Number(totalElapsedRows[0].total);

  const { rows: breakRows } = await query(
    `select coalesce(sum(
       case when break_end is not null then duration_seconds
            else extract(epoch from (now() - break_start))::int
       end
     ), 0) as total
     from break_logs
     where user_id = $1 and date_ist = $2`,
    [userId, today]
  );
  const totalBreakSeconds = Number(breakRows[0].total);

  const workingSeconds = Math.max(0, Math.round(totalElapsedSeconds - totalBreakSeconds));

  const { rows: openBreak } = await query(
    `select * from break_logs where login_session_id = $1 and break_end is null`,
    [currentLoginSessionId]
  );

  return {
    loginTime: firstLoginTime,
    totalBreakSeconds,
    workingSeconds,
    onBreak: openBreak.length > 0,
    currentBreak: openBreak[0] || null
  };
}

/**
 * Item 3: complete login/break/working history for one user, for
 * Master's activity screen. Returns every login session (most recent
 * first), each with its own breaks and computed working time, plus the
 * user's all-time first login and running totals.
 */
async function getUserActivityHistory(userId) {
  const { rows: sessions } = await query(
    `select id, login_time, logout_time, logout_reason, login_date_ist
     from login_sessions
     where user_id = $1
     order by login_time desc
     limit 200`,
    [userId]
  );

  const { rows: firstLoginRows } = await query(
    `select min(login_time) as first_login from login_sessions where user_id = $1`,
    [userId]
  );
  const firstLoginTimeEver = firstLoginRows[0].first_login;

  const sessionsWithBreaks = [];
  let totalBreakSecondsAllTime = 0;
  let totalWorkingSecondsAllTime = 0;

  for (const session of sessions) {
        const { rows: breaks } = await query(
      `select id, break_type, break_start, break_end, duration_seconds
       from break_logs
       where login_session_id = $1
       order by break_start asc`,
      [session.id]
    );

    const sessionBreakSeconds = breaks.reduce((sum, b) => {
      if (b.duration_seconds !== null) return sum + b.duration_seconds;
      // still-open break (only possible for the most recent/current session)
      return sum + Math.floor((Date.now() - new Date(b.break_start).getTime()) / 1000);
    }, 0);

    const sessionEnd = session.logout_time ? new Date(session.logout_time) : new Date();
    const sessionElapsedSeconds = Math.floor((sessionEnd.getTime() - new Date(session.login_time).getTime()) / 1000);
    const sessionWorkingSeconds = Math.max(0, sessionElapsedSeconds - sessionBreakSeconds);

    totalBreakSecondsAllTime += sessionBreakSeconds;
    totalWorkingSecondsAllTime += sessionWorkingSeconds;

    sessionsWithBreaks.push({
      ...session,
      breaks,
      breakSeconds: sessionBreakSeconds,
      workingSeconds: sessionWorkingSeconds
    });
  }

  return {
    firstLoginTimeEver,
    totalBreakSecondsAllTime,
    totalWorkingSecondsAllTime,
    sessions: sessionsWithBreaks
  };
}

module.exports = { getTodayWorkingSummary, getUserActivityHistory };
