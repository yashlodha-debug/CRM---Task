/**
 * Google Sheets API client setup, using a Service Account (free - no
 * per-request cost, generous quota for a team of ~11 people).
 *
 * If credentials aren't set in .env yet, isConfigured() returns false and
 * the sync worker simply skips syncing rather than crashing the app -
 * the CRM itself works fully without Google Sheets ever being set up.
 */
const { google } = require('googleapis');

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY &&
    process.env.GOOGLE_SHEET_ID
  );
}

function getAuth() {
  // .env stores the private key with literal "\n" sequences (since real
  // newlines can't survive a single-line .env value) - convert them back.
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

module.exports = { isConfigured, getSheetsClient };
