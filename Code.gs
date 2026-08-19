/**
 * Student Allocation & Grouping Board — Google Sheets backend
 * ------------------------------------------------------------
 * Deploy this as a Web App (Execute as: Me, Who has access: Anyone).
 * The static GitHub Pages front-end talks to the /exec URL this gives you.
 *
 * Endpoints
 *   GET  ?action=ping                 -> { ok, title }
 *   GET  ?action=rev                  -> { token, writer }         (cheap poll)
 *   GET  ?action=state                -> full workbook state
 *   GET  ?action=files                -> spreadsheets in DRIVE_FOLDER_ID
 *   POST { action:'commit', ... }     -> writes phases + student list
 *
 * All POST bodies are sent as text/plain on purpose: it keeps the request a
 * CORS "simple request" so the browser never fires a preflight OPTIONS call,
 * which Apps Script cannot answer.
 */

var CONFIG = {
  // Leave blank when this script is bound to the spreadsheet (Extensions >
  // Apps Script). Fill in the ID to target a different file.
  SPREADSHEET_ID: '',

  // Optional. Set this to a Drive folder ID to enable the workbook picker.
  DRIVE_FOLDER_ID: '',

  // Must match API_TOKEN in config.js. Change it before you deploy.
  API_TOKEN: 'abcdefghijklmnop',

  SHEETS: {
    list: 'Student list',
    p1: 'Student Data-Phase1',
    p2: 'Student Data-Phase2',
    loc: 'Distribution Locations'
  },

  DATA_START_ROW: 3,  // row 1 = banner, row 2 = column headers
  LAST_COL: 9         // A..I
};

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'ping')  return json_({ ok: true, title: book_().getName() });
    if (action === 'rev')   return json_(revision_());
    if (action === 'state') return json_(readState_());
    if (action === 'files') return json_({ files: listFolder_() });
    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Body is not valid JSON.' });
  }

  if (CONFIG.API_TOKEN && body.token !== CONFIG.API_TOKEN) {
    return json_({ ok: false, error: 'Bad API token.' });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return json_({ ok: false, error: 'The sheet is busy. Try again in a moment.' });
  }

  try {
    if (body.action !== 'commit') {
      return json_({ ok: false, error: 'Unknown action: ' + body.action });
    }

    var ss = book_();
    if (body.students) writeStudents_(sheet_(ss, CONFIG.SHEETS.list), body.students);
    if (body.phases) {
      if (body.phases['1']) writePhase_(sheet_(ss, CONFIG.SHEETS.p1), body.phases['1']);
      if (body.phases['2']) writePhase_(sheet_(ss, CONFIG.SHEETS.p2), body.phases['2']);
    }
    SpreadsheetApp.flush();
    bump_(body.clientId || '');

    var out = readState_();
    out.ok = true;
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function readState_() {
  var ss = book_();
  var rev = revision_();
  return {
    ok: true,
    title: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    token: rev.token,
    writer: rev.writer,
    students: readStudents_(sheet_(ss, CONFIG.SHEETS.list)),
    locations: readLocations_(sheet_(ss, CONFIG.SHEETS.loc)),
    phases: {
      '1': readPhase_(sheet_(ss, CONFIG.SHEETS.p1)),
      '2': readPhase_(sheet_(ss, CONFIG.SHEETS.p2))
    }
  };
}

function readStudents_(sheet) {
  var last = sheet.getLastRow();
  if (last < 1) return [];
  var rows = sheet.getRange(1, 1, last, 2).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var idx = str_(rows[i][0]);
    if (!idx) continue;
    out.push({ index: idx, name: str_(rows[i][1]) });
  }
  return out;
}

function readLocations_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var rows = sheet.getRange(2, 1, last - 1, 3).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var area = str_(rows[i][2]);
    if (!area) continue;
    out.push({ division: str_(rows[i][0]), province: str_(rows[i][1]), area: area });
  }
  return out;
}

/**
 * The phase sheets are slot templates, not flat tables: a group header row
 * ("Group No 1" in column B) followed by numbered slot rows, each carrying a
 * prescribed title (Mr./Ms.). Empty slots are meaningful, so they are kept.
 */
function readPhase_(sheet) {
  var last = sheet.getLastRow();
  if (last < CONFIG.DATA_START_ROW) return [];

  var n = last - CONFIG.DATA_START_ROW + 1;
  var rows = sheet.getRange(CONFIG.DATA_START_ROW, 1, n, CONFIG.LAST_COL).getValues();

  var groups = [], current = null;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var label = str_(r[1]);

    if (/^group\s*no/i.test(label)) {
      current = { name: label, slots: [] };
      groups.push(current);
      continue;
    }
    if (!current) continue;

    var blank = true;
    for (var c = 0; c < CONFIG.LAST_COL; c++) {
      if (str_(r[c]) !== '') { blank = false; break; }
    }
    if (blank) continue;

    current.slots.push({
      title:  str_(r[2]) || 'Mr.',
      index:  str_(r[1]),
      name:   str_(r[3]),
      nic:    str_(r[4]),
      email:  str_(r[5]),
      mobile: str_(r[6]),
      pref1:  str_(r[7]),
      pref2:  str_(r[8])
    });
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

function writeStudents_(sheet, students) {
  var rows = students.map(function (s) {
    return [str_(s.index), str_(s.name)];
  });
  var last = Math.max(sheet.getLastRow(), rows.length);
  if (last > 0) sheet.getRange(1, 1, last, 2).clearContent();
  ensureRows_(sheet, rows.length);
  if (rows.length) sheet.getRange(1, 1, rows.length, 2).setValues(rows);
}

/**
 * Rewrites the whole data region below the header. Slot numbering in column A
 * is regenerated as a clean 1..N sequence — the original file repeated a
 * number at every group boundary (7, 19, 25), which was a copy-paste artefact.
 */
function writePhase_(sheet, groups) {
  var rows = [], headerOffsets = [], seq = 0;

  for (var g = 0; g < groups.length; g++) {
    if (g > 0) rows.push(blankRow_());
    headerOffsets.push(rows.length);

    var head = blankRow_();
    head[1] = groups[g].name || ('Group No ' + (g + 1));
    rows.push(head);

    var slots = groups[g].slots || [];
    for (var s = 0; s < slots.length; s++) {
      var slot = slots[s];
      seq++;
      rows.push([
        seq,
        str_(slot.index), str_(slot.title), str_(slot.name), str_(slot.nic),
        str_(slot.email), str_(slot.mobile), str_(slot.pref1), str_(slot.pref2)
      ]);
    }
  }

  var start = CONFIG.DATA_START_ROW;
  var oldLast = Math.max(sheet.getLastRow(), start);
  sheet.getRange(start, 1, oldLast - start + 1, CONFIG.LAST_COL).clearContent();

  ensureRows_(sheet, start + rows.length);
  if (!rows.length) return;

  var block = sheet.getRange(start, 1, rows.length, CONFIG.LAST_COL);
  block.setValues(rows);
  block.setFontWeight('normal').setBackground(null);
  block.setVerticalAlignment('middle');

  for (var h = 0; h < headerOffsets.length; h++) {
    sheet.getRange(start + headerOffsets[h], 1, 1, CONFIG.LAST_COL)
         .setFontWeight('bold')
         .setBackground('#EEF2FF');
  }
}

function blankRow_() {
  var a = [];
  for (var i = 0; i < CONFIG.LAST_COL; i++) a.push('');
  return a;
}

function ensureRows_(sheet, needed) {
  var have = sheet.getMaxRows();
  if (needed > have) sheet.insertRowsAfter(have, needed - have + 20);
}

/* ------------------------------------------------------------------ */
/* Revision tracking                                                   */
/* ------------------------------------------------------------------ */

/**
 * The token combines our own write counter with Drive's last-modified stamp,
 * so edits typed straight into the Sheet are picked up too, not just ones made
 * through the dashboard.
 */
function revision_() {
  var props = PropertiesService.getScriptProperties();
  var rev = Number(props.getProperty('rev') || 0);
  var driveMs = 0;
  try {
    driveMs = DriveApp.getFileById(book_().getId()).getLastUpdated().getTime();
  } catch (err) {
    driveMs = 0; // Drive scope not granted — dashboard writes are still tracked
  }
  return {
    ok: true,
    token: rev + ':' + driveMs,
    writer: props.getProperty('writer') || ''
  };
}

function bump_(clientId) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('rev', String(Number(props.getProperty('rev') || 0) + 1));
  props.setProperty('writer', clientId);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function book_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('No bound spreadsheet. Set CONFIG.SPREADSHEET_ID.');
  return active;
}

function sheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Sheet not found: "' + name + '"');
  return sh;
}

function listFolder_() {
  if (!CONFIG.DRIVE_FOLDER_ID) return [];
  var out = [];
  var it = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID)
                   .getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) {
    var f = it.next();
    out.push({ id: f.getId(), name: f.getName(), updated: f.getLastUpdated().toISOString() });
  }
  return out;
}

function str_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* Run this once from the editor to grant permissions before deploying */
/* ------------------------------------------------------------------ */

function setup() {
  var state = readState_();
  Logger.log('Workbook: %s', state.title);
  Logger.log('Students: %s   Locations: %s', state.students.length, state.locations.length);
  Logger.log('Phase 1 groups: %s   Phase 2 groups: %s',
             state.phases['1'].length, state.phases['2'].length);
  Logger.log('Revision token: %s', state.token);
}
