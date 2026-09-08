/**
 * Google Sheets API client setup, using a Service Account (free - no
 * per-request cost, generous quota for a team of ~11 people).
 *
 * Credentials are read directly from the JSON key file Google gives you
 * when you create the Service Account - NOT copy-pasted into .env. This
 * avoids the fragility of trying to cram a multi-line private key into a
 * single .env line (quoting/escaping issues, dotenv's auto-newline
 * conversion behavior, accidental whitespace, etc).
 *
 * If credentials aren't set up yet, isConfigured() returns false and the
 * sync worker simply skips syncing rather than crashing the app - the
 * CRM itself works fully without Google Sheets ever being set up.
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

function resolveKeyFilePath() {
  const configured = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!configured) return null;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function isConfigured() {
  const keyFilePath = resolveKeyFilePath();
  return Boolean(keyFilePath && fs.existsSync(keyFilePath) && process.env.GOOGLE_SHEET_ID);
}

function loadCredentials() {
  const keyFilePath = resolveKeyFilePath();
  if (!keyFilePath) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set in .env.');
  }
  if (!fs.existsSync(keyFilePath)) {
    throw new Error(`Google service account key file not found at: ${keyFilePath}`);
  }
  const raw = fs.readFileSync(keyFilePath, 'utf8');
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${keyFilePath} is not valid JSON - did you save the correct downloaded file?`);
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error(`${keyFilePath} is missing client_email or private_key - is this the right file?`);
  }
  return creds;
}

function getAuth() {
  const creds = loadCredentials();
  // Using the modern options-object constructor here (rather than the
  // older positional-arguments form) since newer versions of
  // google-auth-library handle it more reliably.
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  await auth.authorize(); // force an explicit token fetch, so auth failures
                          // surface clearly here rather than as a vague
                          // "unregistered caller" error from the Sheets API
  return google.sheets({ version: 'v4', auth });
}

module.exports = { isConfigured, getSheetsClient, loadCredentials };
