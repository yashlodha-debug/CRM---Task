/**
 * Standalone Google Sheets connection test - run this directly to check
 * your credentials without going through the rest of the CRM.
 *
 * Usage: node scripts/test-sheets-connection.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function run() {
  console.log('--- Checking environment variables ---');
  const keyFileSetting = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = process.env.GOOGLE_SHEET_TAB_NAME || 'Sheet1';

  console.log('GOOGLE_SERVICE_ACCOUNT_KEY_FILE:', keyFileSetting || '(MISSING)');
  console.log('GOOGLE_SHEET_ID:', sheetId || '(MISSING)');
  console.log('GOOGLE_SHEET_TAB_NAME:', tabName);

  if (!keyFileSetting || !sheetId) {
    console.log('\n❌ Missing required environment variables. Stopping here.');
    process.exit(1);
  }

  const keyFilePath = path.isAbsolute(keyFileSetting) ? keyFileSetting : path.join(process.cwd(), keyFileSetting);
  console.log('Resolved key file path:', keyFilePath);

  console.log('\n--- Checking the key file itself ---');
  if (!fs.existsSync(keyFilePath)) {
    console.log('❌ File does not exist at that path. Double-check GOOGLE_SERVICE_ACCOUNT_KEY_FILE');
    console.log('   and make sure the JSON file is actually saved there.');
    process.exit(1);
  }
  console.log('✅ File exists.');

  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
    console.log('✅ File is valid JSON.');
  } catch (err) {
    console.log('❌ File is not valid JSON. Did you accidentally save the wrong file, or edit it by hand?');
    process.exit(1);
  }

  console.log('client_email:', creds.client_email || '(MISSING)');
  console.log('private_key present:', Boolean(creds.private_key));
  if (creds.private_key) {
    console.log('  Length:', creds.private_key.length);
    console.log('  Starts with:', creds.private_key.slice(0, 27));
  }

  if (!creds.client_email || !creds.private_key) {
    console.log('\n❌ This JSON file is missing client_email or private_key.');
    console.log('   Make sure you downloaded a Service Account KEY file, not some other file.');
    process.exit(1);
  }

  console.log('\n--- Attempting to authorize with Google ---');
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  try {
    await auth.authorize();
    console.log('✅ Authorization succeeded - credentials are valid.');
  } catch (err) {
    console.log('❌ Authorization FAILED. This usually means the Google Sheets API');
    console.log('   has not been enabled for this Google Cloud project yet.');
    console.log('\nFull error:', err.message);
    process.exit(1);
  }

  console.log('\n--- Attempting to read row 1 (headers) from your sheet ---');
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!1:1`
    });
    console.log('✅ Successfully read from the sheet!');
    console.log('Header row found:', res.data.values?.[0] || '(empty row)');
    console.log('\nEverything is working. The CRM sync should work now too.');
  } catch (err) {
    console.log('❌ Could not read the sheet. This usually means either:');
    console.log('   1. The sheet has not been shared with this email:', creds.client_email);
    console.log('   2. GOOGLE_SHEET_ID or GOOGLE_SHEET_TAB_NAME is wrong');
    console.log('\nFull error:', err.message);
    process.exit(1);
  }
}

run();
