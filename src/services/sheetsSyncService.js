/**
 * Writes a single task's current state to the Google Sheet, matched by
 * Task UID. This is a ONE-WAY mirror - the CRM database is always the
 * source of truth; nothing is ever read back from the Sheet into the CRM.
 *
 * Columns are matched by header text (row 1 of the sheet), not by fixed
 * column letters, so this keeps working even if your sheet's column
 * order ever changes.
 */
const { isConfigured, getSheetsClient } = require('./sheetsClient');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB_NAME = process.env.GOOGLE_SHEET_TAB_NAME || 'Sheet1';

// Our field name -> the exact header text expected in row 1 of your sheet.
const FIELD_TO_HEADER = {
  mail_date: 'Mail Date',
  assign_date: 'Assign Date',
  assigned_full_name: 'Assigned',
  task_type: 'Task',
  related_to: 'Related to',
  exis_data: 'Exis Data',
  rest_id: 'Rest ID',
  rest_name: 'Rest Name',
  email_subject: 'Email Subject',
  recipes_count: 'Recipes Count',
  raw_count: 'Raw Count',
  status: 'Status',
  dashboard_status: 'Dashboard Status',
  start_time: 'Start Time',
  end_time: 'End Time',
  duration_seconds: 'Duration Time',
  last_comment: 'Comment',
  suggested: 'Suggested',
  sla: 'SLA',
  task_uid: 'Task UID'
};

let headerCache = null;

async function getHeaderMap(sheets) {
  if (headerCache) return headerCache;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!1:1`
  });
  const headers = res.data.values?.[0] || [];
  const map = {};
  headers.forEach((h, idx) => {
    map[String(h).trim()] = idx;
  });
  headerCache = map;
  return map;
}

/** Converts a 0-based column index to its A1 letter (0 -> A, 26 -> AA, ...) */
function colLetter(index) {
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** DD/MM/YYYY, matching the existing sheet's date columns - no time portion. */
function formatDateOnly(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
}

/** e.g. "6:25:10 PM", matching the existing sheet's Start/End Time columns. */
function formatTimeOnly(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

const FIELD_FORMATTERS = {
  duration_seconds: formatDuration,
  mail_date: formatDateOnly,
  assign_date: formatDateOnly,
  start_time: formatTimeOnly,
  end_time: formatTimeOnly
};

// Fields forced to plain text (a leading apostrophe tells Sheets "store
// this exactly as typed, never auto-convert it"). Without this, Sheets'
// USER_ENTERED parsing sometimes reinterprets a date/time-looking string
// as its own internal date serial number, which then displays as a raw
// number like "46151" on any cell that doesn't already have a Date format
// applied - a real inconsistency we saw happen on freshly-touched rows.
const FORCE_PLAIN_TEXT_FIELDS = new Set(['mail_date', 'assign_date', 'start_time', 'end_time', 'duration_seconds']);

function buildRowArray(headerMap, task) {
  const width = Math.max(...Object.values(headerMap)) + 1;
  const row = new Array(width).fill('');

  for (const [field, header] of Object.entries(FIELD_TO_HEADER)) {
    if (!(header in headerMap)) continue; // sheet doesn't have this column - skip it
    const idx = headerMap[header];
    let value = task[field];
    const formatter = FIELD_FORMATTERS[field];
    if (formatter) {
      value = formatter(value);
    }
    let finalValue = value === null || value === undefined ? '' : String(value);
    if (finalValue && FORCE_PLAIN_TEXT_FIELDS.has(field)) {
      finalValue = `'${finalValue}`;
    }
    row[idx] = finalValue;
  }

  return row;
}

async function findRowByTaskUid(sheets, headerMap, taskUid) {
  const uidCol = headerMap['Task UID'];
  if (uidCol === undefined) return null;

  const letter = colLetter(uidCol);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!${letter}2:${letter}100000`
  });
  const values = res.data.values || [];

  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === taskUid) return i + 2; // +1 for 1-based, +1 for header row
  }
  return null;
}

/**
 * Syncs one task's current state to the sheet - updates the existing row
 * if the Task UID is already there, otherwise appends a new row.
 */
async function syncTask(task) {
  if (!isConfigured()) {
    throw new Error('Google Sheets sync is not configured yet.');
  }

  const sheets = await getSheetsClient();
  const headerMap = await getHeaderMap(sheets);
  const rowArray = buildRowArray(headerMap, task);
  const lastCol = colLetter(rowArray.length - 1);

  const existingRow = await findRowByTaskUid(sheets, headerMap, task.task_uid);

  if (existingRow) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}!A${existingRow}:${lastCol}${existingRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowArray] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: 'USER_ENTERED',
      // OVERWRITE finds the next actually-empty row after your existing
      // data and writes into it directly - it does NOT insert a brand-new
      // row and push everything below it down. INSERT_ROWS was the actual
      // cause of the dropdowns/formatting appearing to vanish: it was
      // inserting fresh, blank rows right after the header, shoving your
      // pre-formatted template rows further down the sheet each time.
      insertDataOption: 'OVERWRITE',
      requestBody: { values: [rowArray] }
    });
  }
}

/** Clears the cached header row - call this if you edit the sheet's headers. */
function clearHeaderCache() {
  headerCache = null;
}

module.exports = { syncTask, clearHeaderCache };
