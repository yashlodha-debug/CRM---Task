/**
 * Generates a unique Task UID like TASK-20260901-0001.
 *
 * Must always be called with a `client` that is part of an active
 * transaction (see db/pool.js withTransaction). The UPDATE...RETURNING
 * below is atomic at the database level, so two people creating a task
 * at the exact same moment can never receive the same number - the
 * second request simply waits for the first to finish, then gets the
 * next sequence value. This is what "Do not allow duplicate Task UID"
 * (blueprint section 6) actually guarantees in practice.
 */
const { todayIST } = require('./date');

async function generateTaskUid(client) {
  const dateKey = todayIST().replace(/-/g, ''); // 'YYYY-MM-DD' -> 'YYYYMMDD'

  await client.query(
    `insert into task_uid_counters (date_key, last_seq)
     values ($1, 0)
     on conflict (date_key) do nothing`,
    [dateKey]
  );

  const { rows } = await client.query(
    `update task_uid_counters
     set last_seq = last_seq + 1
     where date_key = $1
     returning last_seq`,
    [dateKey]
  );

  const seq = rows[0].last_seq;
  const seqStr = String(seq).padStart(4, '0');
  return `TASK-${dateKey}-${seqStr}`;
}

module.exports = { generateTaskUid };
