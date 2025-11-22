// utils/googleSheets.js
import { google } from 'googleapis';
import path from 'path';

// Path to your credentials.json
const KEYFILE_PATH = path.join(process.cwd(), 'credentials.json');

// Scopes required to read Google Sheets
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// Authenticate using service account key
const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILE_PATH,
  scopes: SCOPES,
});

const sheets = google.sheets({ version: 'v4', auth });

/**
 * Fetch responses from Google Sheets
 * @param {string} spreadsheetId - The ID of the Google Sheet
 * @param {string} range - The range of cells to read (e.g., "Form Responses!A2:Z")
 */
export async function fetchResponses(spreadsheetId, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return response.data.values || []; // Returns rows as arrays
  } catch (error) {
    console.error('Error fetching data from Google Sheets:', error.message);
    throw new Error('Failed to fetch responses from Google Sheets');
  }
}
