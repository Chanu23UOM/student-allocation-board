/* Student Allocation & Grouping Board
   Static front-end. Talks to a Google Apps Script web app for read/write. */

(function () {
'use strict';

var CFG   = window.APP_CONFIG || {};
var DEMO  = !CFG.API_URL;
var POLL  = CFG.POLL_MS || 6000;
var SAVE  = CFG.AUTOSAVE_MS || 1500;

var $  = function (sel, root) { return (root || document).querySelector(sel); };
var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

/* ================================================================== */
/* State                                                              */
/* ================================================================== */

var S = {
  students:  [],
  locations: [],
  phases:    { '1': [], '2': [] },
  view:      'board',
  phase:     '1',
  search:    '',
  rosterSearch: '',
  rosterPhase: 'all',
  rosterGroup: 'all',
  rosterSort: 'index',
  rosterAsc: true,
  picked:    null,          // index of a student clicked in the pool
  editing:   null,          // { phase, g, s } currently open in the modal
  dirty:     false,
  saving:    false,
  token:     null,
  clientId:  'c' + Math.random().toString(36).slice(2, 10),
  conflict:  false,
  saveTimer: null,
  lastSaved: null
};

/* ================================================================== */
/* Small helpers                                                      */
/* ================================================================== */

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function phaseList() { return S.phase === 'all' ? ['1', '2'] : [S.phase]; }

function slotFilled(slot) { return !!(slot && (slot.index || slot.name)); }

function studentByIndex(idx) {
  if (!idx) return null;
  for (var i = 0; i < S.students.length; i++) {
    if (S.students[i].index === idx) return S.students[i];
  }
  return null;
}

/** Every slot a student currently occupies, across both phases. */
function placementsOf(idx) {
  var out = [];
  ['1', '2'].forEach(function (p) {
    S.phases[p].forEach(function (grp, g) {
      grp.slots.forEach(function (slot, s) {
        if (slot.index && slot.index === idx) out.push({ phase: p, g: g, s: s, group: grp.name });
      });
    });
  });
  return out;
}

function assignedCount(phase) {
  var n = 0;
  S.phases[phase].forEach(function (grp) {
    grp.slots.forEach(function (slot) { if (slotFilled(slot)) n++; });
  });
  return n;
}

/** Students with no slot in the given phase (or in neither, when 'all'). */
function poolFor(phase) {
  var taken = {};
  var scan = phase === 'all' ? ['1', '2'] : [phase];
  scan.forEach(function (p) {
    S.phases[p].forEach(function (grp) {
      grp.slots.forEach(function (slot) { if (slot.index) taken[slot.index] = true; });
    });
  });
  return S.students.filter(function (st) { return !taken[st.index]; });
}

function matchesSearch(hay) {
  if (!S.search) return true;
  return String(hay || '').toLowerCase().indexOf(S.search) !== -1;
}

function toast(msg, bad) {
  var el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (bad ? ' bad' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.hidden = true; }, 2600);
}

/* ================================================================== */
/* Validation                                                         */
/* ================================================================== */

var RE = {
  nic:    /^(?:\d{9}[vVxX]|\d{12})$/,
  mobile: /^(?:\+94|0)?7\d{8}$/,
  email:  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
};

function checkField(kind, value) {
  var v = String(value || '').replace(/\s/g, '');
  if (!v) return { ok: true, note: '' };
  if (kind === 'nic') {
    return RE.nic.test(v)
      ? { ok: true,  note: v.length === 12 ? 'New-format NIC' : 'Old-format NIC' }
      : { ok: false, note: 'Use 12 digits, or 9 digits ending in V or X.' };
  }
  if (kind === 'mobile') {
    return RE.mobile.test(v)
      ? { ok: true,  note: 'Valid Sri Lankan mobile' }
      : { ok: false, note: 'Use 07XXXXXXXX or +947XXXXXXXX.' };
  }
  if (kind === 'email') {
    return RE.email.test(v) ? { ok: true, note: '' } : { ok: false, note: 'That does not look like an email address.' };
  }
  return { ok: true, note: '' };
}

/* ================================================================== */
/* API                                                                */
/* ================================================================== */

function apiGet(action) {
  var url = CFG.API_URL + (CFG.API_URL.indexOf('?') === -1 ? '?' : '&') + 'action=' + encodeURIComponent(action);
  return fetch(url, { method: 'GET', redirect: 'follow' }).then(function (r) { return r.json(); });
}

/* Sent as text/plain so the browser treats it as a simple request and skips
   the preflight, which Apps Script cannot answer. */
function apiPost(payload) {
  payload.token = CFG.API_TOKEN;
  payload.clientId = S.clientId;
  return fetch(CFG.API_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json(); });
}

function setSync(text, kind) {
  var pill = $('#syncPill');
  pill.textContent = text;
  pill.className = 'pill ' + (kind || 'pill-idle');
}

function markDirty() {
  S.dirty = true;
  if (DEMO) { setSync('Demo mode — not saved', 'pill-warn'); return; }
  setSync('Unsaved changes', 'pill-warn');
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, SAVE);
}

function save() {
  if (DEMO || S.saving || !S.dirty) return Promise.resolve();
  S.saving = true;
  setSync('Saving…', 'pill-busy');

  return apiPost({
    action:   'commit',
    students: S.students,
    phases:   S.phases
  }).then(function (res) {
    S.saving = false;
    if (!res || !res.ok) throw new Error((res && res.error) || 'Save failed');
    S.dirty = false;
    S.token = res.token;
    S.lastSaved = new Date();
    setSync('Saved ' + S.lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'pill-ok');
  }).catch(function (err) {
    S.saving = false;
    setSync('Save failed', 'pill-error');
    toast(err.message || 'Could not reach the sheet.', true);
  });
}

function adoptState(res) {
  S.students  = res.students  || [];
  S.locations = res.locations || [];
  S.phases    = { '1': (res.phases && res.phases['1']) || [], '2': (res.phases && res.phases['2']) || [] };
  S.token     = res.token || null;
  S.dirty     = false;
  S.conflict  = false;
  $('#banner').hidden = true;
  buildLocationOptions();
  buildIndexDatalist();
  render();
}

function poll() {
  if (DEMO || S.saving) return;
  apiGet('rev').then(function (res) {
    if (!res || !res.ok || !res.token) return;
    if (res.token === S.token) return;

    // Our own write coming back to us.
    if (res.writer === S.clientId) { S.token = res.token; return; }

    if (S.dirty) {
      S.conflict = true;
      $('#bannerText').textContent = 'The sheet changed somewhere else while you have unsaved edits.';
      $('#banner').hidden = false;
      setSync('Out of sync', 'pill-error');
      return;
    }
    apiGet('state').then(function (st) {
      if (st && st.ok) { adoptState(st); toast('Reloaded from the sheet'); }
    });
  }).catch(function () { /* transient network failures are ignored */ });
}

/* ================================================================== */
/* Mutations                                                          */
/* ================================================================== */

function firstEmptySlot(phase, g) {
  var slots = S.phases[phase][g].slots;
  for (var i = 0; i < slots.length; i++) if (!slotFilled(slots[i])) return i;
  return -1;
}

function blankSlot(title) {
  return { title: title || 'Mr.', index: '', name: '', nic: '', email: '', mobile: '', pref1: '', pref2: '' };
}

function assign(index, phase, g, s) {
  var grp = S.phases[phase][g];
  if (!grp) return;

  if (s == null || s < 0) {
    s = firstEmptySlot(phase, g);
    if (s === -1) { grp.slots.push(blankSlot()); s = grp.slots.length - 1; }
  }

  // Same phase, one slot per student.
  placementsOf(index).forEach(function (p) {
    if (p.phase === phase) clearSlot(phase, p.g, p.s, true);
  });

  var slot = grp.slots[s];
  var st = studentByIndex(index);
  slot.index = index;
  if (st && !slot.name) slot.name = st.name;
  if (!slot.title) slot.title = 'Mr.';

  markDirty();
  render();
}

function clearSlot(phase, g, s, quiet) {
  var slots = S.phases[phase][g] && S.phases[phase][g].slots;
  if (!slots || !slots[s]) return;
  var title = slots[s].title;
  slots[s] = blankSlot(title);
  if (!quiet) { markDirty(); render(); }
}

function moveSlot(from, to) {
  if (from.phase === to.phase && from.g === to.g && from.s === to.s) return;

  var src = S.phases[from.phase][from.g].slots[from.s];
  var dstGroup = S.phases[to.phase][to.g];
  var ds = to.s;
  if (ds == null || ds < 0) {
    ds = firstEmptySlot(to.phase, to.g);
    if (ds === -1) { dstGroup.slots.push(blankSlot()); ds = dstGroup.slots.length - 1; }
  }
  var dst = dstGroup.slots[ds];

  // Keep each slot's prescribed title with the slot, not with the student.
  var moved = clone(src); moved.title = dst.title || src.title;
  var back  = clone(dst); back.title  = src.title;

  dstGroup.slots[ds] = moved;
  S.phases[from.phase][from.g].slots[from.s] = slotFilled(dst) ? back : blankSlot(src.title);

  markDirty();
  render();
}

function addSlot(phase, g) {
  S.phases[phase][g].slots.push(blankSlot());
  markDirty(); render();
}

function removeEmptySlot(phase, g) {
  var slots = S.phases[phase][g].slots;
  for (var i = slots.length - 1; i >= 0; i--) {
    if (!slotFilled(slots[i])) { slots.splice(i, 1); markDirty(); render(); return; }
  }
  toast('Every slot in this group is filled.', true);
}

function autoAllocate() {
  var phases = phaseList();
  var pool = poolFor(S.phase).slice();
  if (!pool.length) { toast('No unassigned students to place.'); return; }

  var empties = 0;
  phases.forEach(function (p) {
    S.phases[p].forEach(function (grp) {
      grp.slots.forEach(function (slot) { if (!slotFilled(slot)) empties++; });
    });
  });
  if (!empties) { toast('There are no empty slots in this phase.', true); return; }

  var label = S.phase === 'all' ? 'Phase 1 and Phase 2' : 'Phase ' + S.phase;
  var n = Math.min(pool.length, empties);
  if (!window.confirm('Fill ' + n + ' empty slot' + (n === 1 ? '' : 's') + ' in ' + label +
                      ' with students from the pool, in list order?')) return;

  var k = 0;
  phases.forEach(function (p) {
    S.phases[p].forEach(function (grp) {
      grp.slots.forEach(function (slot) {
        if (slotFilled(slot) || k >= pool.length) return;
        var st = pool[k++];
        slot.index = st.index;
        slot.name = st.name;
      });
    });
  });

  markDirty(); render();
  toast('Placed ' + k + ' student' + (k === 1 ? '' : 's') + '. Review the titles before saving.');
}

function addStudent() {
  var index = window.prompt('New student index (for example 230999Z)');
  if (!index) return;
  index = index.trim();
  if (studentByIndex(index)) { toast('That index is already in the student list.', true); return; }
  var name = (window.prompt('Full name for ' + index) || '').trim();
  S.students.push({ index: index, name: name });
  S.students.sort(function (a, b) { return a.name.localeCompare(b.name); });
  buildIndexDatalist();
  markDirty(); render();
  toast(index + ' added to the pool.');
}

function placementOf(idx) {
  var found = null;
  ['1', '2'].some(function (p) {
    return S.phases[p].some(function (grp, g) {
      return grp.slots.some(function (slot, s) {
        if (slot.index !== idx) return false;
        found = { phase: p, g: g, s: s, group: grp.name, slot: slot };
        return true;
      });
    });
  });
  return found;
}

function deleteStudent(index) {
  var st = studentByIndex(index);
  if (!st || !window.confirm('Remove ' + (st.name || index) + ' from the roster?')) return;
  ['1', '2'].forEach(function (p) {
    S.phases[p].forEach(function (grp) {
      grp.slots.forEach(function (slot) {
        if (slot.index === index) {
          slot.index = ''; slot.name = ''; slot.nic = ''; slot.email = '';
          slot.mobile = ''; slot.pref1 = ''; slot.pref2 = '';
        }
      });
    });
  });
  S.students = S.students.filter(function (student) { return student.index !== index; });
  buildIndexDatalist();
  markDirty(); render();
  toast('Removed ' + index + ' from the roster.');
}

/* ================================================================== */
/* Rendering — board                                                  */
/* ================================================================== */

var ICON_GRIP = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
var ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
var ICON_USERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13A4 4 0 0 1 16 11"/></svg>';

function poolCardHTML(st) {
  var elsewhere = placementsOf(st.index);
  var tags = elsewhere.map(function (p) {
    return '<span class="tag tag-p' + p.phase + '">P' + p.phase + ' · ' + esc(p.group.replace(/^Group No\s*/i, 'G')) + '</span>';
  }).join('');

  return '' +
    '<article class="card' + (S.picked === st.index ? ' is-picked' : '') + '"' +
    ' draggable="true" data-from="pool" data-index="' + esc(st.index) + '" tabindex="0">' +
      '<div class="card-top">' +
        '<span class="grip">' + ICON_GRIP + '</span>' +
        '<span class="chip">' + esc(st.index) + '</span>' +
        '<span class="card-actions">' +
          '<button class="icon-btn" data-act="edit-pool" data-index="' + esc(st.index) + '" title="Edit details" type="button">' + ICON_EDIT + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="card-name">' + esc(st.name || '—') + '</div>' +
      (tags ? '<div class="card-meta">' + tags + '</div>' : '') +
    '</article>';
}

function slotCardHTML(slot, phase, g, s) {
  var st = studentByIndex(slot.index);
  var name = slot.name || (st && st.name) || '';
  var hit = S.search && (matchesSearch(slot.index) || matchesSearch(name) || matchesSearch(slot.nic));

  var missing = [];
  if (!slot.nic)    missing.push('NIC');
  if (!slot.email)  missing.push('email');
  if (!slot.mobile) missing.push('mobile');
  if (!slot.pref1)  missing.push('preference');

  var meta = '';
  if (slot.pref1) {
    meta += '<span><b>1.</b> ' + esc(slot.pref1) + '</span>';
    if (slot.pref2) meta += '<span><b>2.</b> ' + esc(slot.pref2) + '</span>';
  }
  if (missing.length) meta += '<span class="tag tag-gap">' + esc(missing.length) + ' missing</span>';

  var other = placementsOf(slot.index).filter(function (p) { return p.phase !== phase; });
  other.forEach(function (p) {
    meta += '<span class="tag tag-p' + p.phase + '">also P' + p.phase + '</span>';
  });

  return '' +
    '<article class="card' + (hit ? ' is-hit' : '') + '" draggable="true"' +
    ' data-from="slot" data-phase="' + phase + '" data-g="' + g + '" data-s="' + s + '" tabindex="0">' +
      '<div class="card-top">' +
        '<span class="grip">' + ICON_GRIP + '</span>' +
        '<span class="chip">' + esc(slot.index || '—') + '</span>' +
        '<span class="card-actions">' +
          '<button class="icon-btn" data-act="edit" data-phase="' + phase + '" data-g="' + g + '" data-s="' + s + '" title="Edit details" type="button">' + ICON_EDIT + '</button>' +
          '<button class="icon-btn danger" data-act="clear" data-phase="' + phase + '" data-g="' + g + '" data-s="' + s + '" title="Return to pool" type="button">' + ICON_TRASH + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="card-name">' + esc(slot.title ? slot.title + ' ' : '') + esc(name || 'Unnamed') + '</div>' +
      (meta ? '<div class="card-meta">' + meta + '</div>' : '') +
    '</article>';
}

function groupColumnHTML(phase, grp, g) {
  var filled = grp.slots.filter(slotFilled).length;
  var total  = grp.slots.length;
  var body = '';

  grp.slots.forEach(function (slot, s) {
    if (slotFilled(slot)) {
      body += slotCardHTML(slot, phase, g, s);
    } else {
      body += '<div class="slot" data-drop="slot" data-phase="' + phase + '" data-g="' + g + '" data-s="' + s + '" tabindex="0">' +
                '<span class="slot-title">' + esc(slot.title || 'Mr.') + '</span> slot ' + (s + 1) + ' · empty' +
              '</div>';
    }
  });

  if (!total) {
    body = '<div class="empty-drop">' + ICON_USERS + '<span>No slots yet. Use + to add one.</span></div>';
  }

  return '' +
    '<section class="col" data-drop="group" data-phase="' + phase + '" data-g="' + g + '">' +
      '<header class="col-head">' +
        '<span class="col-title">' + esc(grp.name) + '</span>' +
        '<span class="count' + (filled === total && total ? ' count-full' : '') + '">' + filled + '/' + total + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="icon-btn" data-act="slot-minus" data-phase="' + phase + '" data-g="' + g + '" title="Remove an empty slot" type="button">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg></button>' +
        '<button class="icon-btn" data-act="slot-plus" data-phase="' + phase + '" data-g="' + g + '" title="Add a slot" type="button">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>' +
      '</header>' +
      '<div class="col-note">Phase ' + phase + '</div>' +
      '<div class="col-body">' + body + '</div>' +
    '</section>';
}

function poolColumnHTML(phase) {
  var pool = poolFor(phase).filter(function (st) {
    return matchesSearch(st.index) || matchesSearch(st.name);
  });

  var body = pool.length
    ? pool.map(poolCardHTML).join('')
    : '<div class="empty-drop">' + ICON_USERS + '<span>' +
      (S.search ? 'No students match that search.' : 'Everyone has a slot in this phase.') +
      '</span></div>';

  var label = phase === 'all' ? 'Unassigned in both phases' :
              'Drag onto a slot, or click a card then click a slot';

  return '' +
    '<section class="col col-pool" data-drop="pool">' +
      '<header class="col-head">' +
        '<span class="col-title">Unassigned pool</span>' +
        '<span class="count">' + pool.length + '</span>' +
        '<span class="spacer"></span>' +
        '<button class="icon-btn" data-act="add-student" title="Add a student" type="button">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>' +
      '</header>' +
      '<div class="col-note">' + esc(label) + '</div>' +
      '<div class="col-body">' + body + '</div>' +
    '</section>';
}

function renderBoard() {
  var host = $('#viewBoard');
  var phases = phaseList();
  var html = '';

  if (S.phase === 'all') {
    html += '<div class="board">' + poolColumnHTML('all') + '</div>';
    phases.forEach(function (p) {
      html += '<div class="phase-block"><h2 class="phase-heading">Phase ' + p + '</h2><div class="board">' +
              S.phases[p].map(function (grp, g) { return groupColumnHTML(p, grp, g); }).join('') +
              '</div></div>';
    });
  } else {
    var p = phases[0];
    html += '<div class="board">' + poolColumnHTML(p) +
            S.phases[p].map(function (grp, g) { return groupColumnHTML(p, grp, g); }).join('') +
            '</div>';
  }

  host.innerHTML = html;
}

/* ================================================================== */
/* Rendering — spreadsheet view                                       */
/* ================================================================== */

var COLS = [
  { key: 'index',  label: 'Index',    w: 100 },
  { key: 'title',  label: 'Title',    w: 70, select: ['Mr.', 'Ms.'] },
  { key: 'name',   label: 'Name',     w: 220 },
  { key: 'nic',    label: 'NIC',      w: 130, check: 'nic' },
  { key: 'email',  label: 'Email',    w: 210, check: 'email' },
  { key: 'mobile', label: 'Mobile',   w: 130, check: 'mobile' },
  { key: 'pref1',  label: 'Preference 1', w: 160, loc: true },
  { key: 'pref2',  label: 'Preference 2', w: 160, loc: true }
];

function cellHTML(slot, phase, g, s, col) {
  var val = slot[col.key] || '';
  var attrs = 'data-phase="' + phase + '" data-g="' + g + '" data-s="' + s + '" data-key="' + col.key + '"';

  if (col.select) {
    return '<select class="cell" ' + attrs + '>' +
      col.select.map(function (o) {
        return '<option' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>';
  }
  if (col.loc) {
    // A shared datalist keeps this cheap — 66 rows x 2 full selects would be
    // roughly 300 KB of markup per phase.
    var unknown = val && !AREA_SET[val];
    return '<input class="cell' + (unknown ? ' is-bad' : '') + '" list="areaList" ' + attrs +
           ' value="' + esc(val) + '" style="min-width:' + col.w + 'px" autocomplete="off"' +
           (unknown ? ' title="Not an area in Distribution Locations"' : '') + '>';
  }
  var bad = col.check && !checkField(col.check, val).ok;
  return '<input class="cell' + (bad ? ' is-bad' : '') + '" ' + attrs +
         ' value="' + esc(val) + '" style="min-width:' + col.w + 'px" autocomplete="off">';
}

function renderSheet() {
  var host = $('#viewSheet');
  var html = '';

  phaseList().forEach(function (phase) {
    var rows = '';
    var n = 0;

    S.phases[phase].forEach(function (grp, g) {
      rows += '<tr class="group-row"><td colspan="' + (COLS.length + 2) + '">' + esc(grp.name) + '</td></tr>';
      grp.slots.forEach(function (slot, s) {
        n++;
        var name = (slot.name || '') + ' ' + (slot.index || '') + ' ' + (slot.nic || '');
        if (!matchesSearch(name)) return;
        rows += '<tr><td class="num">' + n + '</td>' +
                COLS.map(function (c) { return '<td>' + cellHTML(slot, phase, g, s, c) + '</td>'; }).join('') +
                '<td class="pad"><button class="icon-btn danger" data-act="clear" data-phase="' + phase +
                '" data-g="' + g + '" data-s="' + s + '" title="Clear this row" type="button">' + ICON_TRASH + '</button></td></tr>';
      });
    });

    html += '<div class="panel">' +
      '<div class="panel-head"><h2>Student Data-Phase' + phase + '</h2>' +
        '<span class="pill">' + assignedCount(phase) + ' filled</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-ghost btn-tiny" data-act="export" data-phase="' + phase + '" type="button">Export CSV</button>' +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr><th>#</th>' +
        COLS.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') +
        '<th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  });

  host.innerHTML = html;
}

function renderRoster() {
  var host = $('#viewRoster');
  var groups = {};
  ['1', '2'].forEach(function (p) {
    S.phases[p].forEach(function (grp, g) {
      grp.slots.forEach(function (slot, s) {
        if (slot.index) groups[p + '|' + slot.index] = { phase: p, g: g, s: s, group: grp.name, slot: slot };
      });
    });
  });

  var rows = S.students.map(function (st) {
    var p = groups['1|' + st.index] || groups['2|' + st.index];
    return { student: st, placement: p || null };
  }).filter(function (row) {
    var st = row.student, p = row.placement;
    var query = S.rosterSearch;
    var hay = [st.index, st.name, st.nic, p && p.group, p && ('phase ' + p.phase)].join(' ').toLowerCase();
    if (query && hay.indexOf(query) === -1) return false;
    if (S.rosterPhase === 'unassigned' && p) return false;
    if (S.rosterPhase !== 'all' && S.rosterPhase !== 'unassigned' && (!p || p.phase !== S.rosterPhase)) return false;
    if (S.rosterGroup !== 'all' && (!p || p.group !== S.rosterGroup)) return false;
    return true;
  }).sort(function (a, b) {
    var av = S.rosterSort === 'name' ? a.student.name : S.rosterSort === 'group' ? ((a.placement && a.placement.group) || 'ZZZ') : a.student.index;
    var bv = S.rosterSort === 'name' ? b.student.name : S.rosterSort === 'group' ? ((b.placement && b.placement.group) || 'ZZZ') : b.student.index;
    return (String(av).localeCompare(String(bv))) * (S.rosterAsc ? 1 : -1);
  });

  var body = rows.length ? rows.map(function (row, i) {
    var st = row.student, p = row.placement;
    var phase = p ? '<span class="roster-status roster-p' + p.phase + '">Phase ' + p.phase + '</span>' : '<span class="roster-status roster-gap">Unassigned</span>';
    var action = p
      ? '<button class="btn btn-tiny btn-ghost" data-act="roster-edit" data-phase="' + p.phase + '" data-g="' + p.g + '" data-s="' + p.s + '" type="button">Edit</button>'
      : '<button class="btn btn-tiny btn-primary" data-act="roster-assign" data-index="' + esc(st.index) + '" type="button">Assign</button>';
    return '<tr>' +
      '<td class="num">' + (i + 1) + '</td>' +
      '<td><span class="chip">' + esc(st.index) + '</span></td>' +
      '<td><strong>' + esc(st.name || 'Unnamed') + '</strong></td>' +
      '<td>' + (st.nic ? '<span class="mono">' + esc(st.nic) + '</span>' : '<span class="muted">Not set</span>') + '</td>' +
      '<td>' + phase + '</td>' +
      '<td>' + esc(p ? p.group : '—') + '</td>' +
      '<td class="roster-actions">' + action +
        (p ? '<button class="icon-btn" data-act="roster-unassign" data-phase="' + p.phase + '" data-g="' + p.g + '" data-s="' + p.s + '" title="Unassign student" type="button">' + ICON_TRASH + '</button>' : '') +
        '<button class="icon-btn danger" data-act="roster-delete" data-index="' + esc(st.index) + '" title="Delete student" type="button">' + ICON_TRASH + '</button>' +
      '</td></tr>';
  }).join('') : '<tr><td colspan="7"><p class="notice">No students match the current filters.</p></td></tr>';

  host.innerHTML = '<div class="panel roster-panel">' +
    '<div class="roster-toolbar"><label class="search roster-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input data-roster-control="search" value="' + esc(S.rosterSearch) + '" placeholder="Search index, name, NIC or group" type="search" autocomplete="off"></label>' +
    '<label class="roster-filter">Status <select data-roster-control="phase"><option value="all"' + (S.rosterPhase === 'all' ? ' selected' : '') + '>All students</option><option value="unassigned"' + (S.rosterPhase === 'unassigned' ? ' selected' : '') + '>Unassigned</option><option value="1"' + (S.rosterPhase === '1' ? ' selected' : '') + '>Phase 1</option><option value="2"' + (S.rosterPhase === '2' ? ' selected' : '') + '>Phase 2</option></select></label>' +
    '<label class="roster-filter">Group <select data-roster-control="group"><option value="all">All groups</option>' + S.phases['1'].concat(S.phases['2']).map(function (grp) { return '<option value="' + esc(grp.name) + '"' + (S.rosterGroup === grp.name ? ' selected' : '') + '>' + esc(grp.name) + '</option>'; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join('') + '</select></label>' +
    '<label class="roster-filter">Sort <select data-roster-control="sort"><option value="index"' + (S.rosterSort === 'index' ? ' selected' : '') + '>Index</option><option value="name"' + (S.rosterSort === 'name' ? ' selected' : '') + '>Name</option><option value="group"' + (S.rosterSort === 'group' ? ' selected' : '') + '>Group</option></select></label>' +
    '<button class="btn btn-tiny btn-ghost" data-act="roster-sort-direction" type="button">' + (S.rosterAsc ? 'ASC' : 'DESC') + '</button></div>' +
    '<div class="panel-head"><div><h2>Master student roster</h2><p class="sub">' + rows.length + ' shown of ' + S.students.length + ' registered students</p></div><span class="spacer"></span><button class="btn btn-primary btn-tiny" data-act="add-student" type="button">+ Add student</button></div>' +
    '<div class="table-wrap"><table class="roster-table"><thead><tr><th>#</th><th>Index</th><th>Student</th><th>NIC</th><th>Status</th><th>Group</th><th></th></tr></thead><tbody>' + body + '</tbody></table></div></div>';
}

/* ================================================================== */
/* Rendering — summary                                                */
/* ================================================================== */

function barRow(label, value, max, tone) {
  var pct = max ? Math.round((value / max) * 100) : 0;
  return '<div class="bar-row">' +
    '<span class="bar-label">' + esc(label) + '</span>' +
    '<span class="bar-value">' + value + (max !== value ? ' / ' + max : '') + '</span>' +
    '<span class="bar-track"><span class="bar-fill ' + (tone || '') + '" style="width:' + pct + '%"></span></span>' +
  '</div>';
}

function renderSummary() {
  var host = $('#viewSummary');
  var phases = phaseList();

  // Group fill
  var fill = '';
  phases.forEach(function (p) {
    S.phases[p].forEach(function (grp) {
      var f = grp.slots.filter(slotFilled).length;
      fill += barRow('P' + p + ' · ' + grp.name, f, grp.slots.length, f === grp.slots.length ? 'green' : '');
    });
  });

  // Preference demand
  var demand = {}, divisions = {};
  var byArea = {};
  S.locations.forEach(function (l) { byArea[l.area] = l; });

  phases.forEach(function (p) {
    S.phases[p].forEach(function (grp) {
      grp.slots.forEach(function (slot) {
        if (!slotFilled(slot)) return;
        [slot.pref1, slot.pref2].forEach(function (a, i) {
          if (!a) return;
          demand[a] = (demand[a] || 0) + (i === 0 ? 1 : 0.5);
          var loc = byArea[a];
          if (loc) divisions[loc.division] = (divisions[loc.division] || 0) + 1;
        });
      });
    });
  });

  var top = Object.keys(demand).sort(function (a, b) { return demand[b] - demand[a]; }).slice(0, 10);
  var topMax = top.length ? demand[top[0]] : 0;
  var demandHTML = top.length
    ? top.map(function (a) { return barRow(a, demand[a], topMax, 'blue'); }).join('')
    : '<p class="notice">No preferences recorded yet. Open a student card and pick two areas.</p>';

  var divKeys = Object.keys(divisions).sort();
  var divMax = divKeys.reduce(function (m, k) { return Math.max(m, divisions[k]); }, 0);
  var divHTML = divKeys.length
    ? divKeys.map(function (k) { return barRow(k, divisions[k], divMax, 'amber'); }).join('')
    : '<p class="notice">Nothing to show until preferences are recorded.</p>';

  // Completeness
  var total = 0, have = { nic: 0, email: 0, mobile: 0, pref1: 0, pref2: 0 };
  phases.forEach(function (p) {
    S.phases[p].forEach(function (grp) {
      grp.slots.forEach(function (slot) {
        if (!slotFilled(slot)) return;
        total++;
        Object.keys(have).forEach(function (k) { if (slot[k]) have[k]++; });
      });
    });
  });

  var completeness = total
    ? [['NIC', 'nic'], ['Email', 'email'], ['Mobile number', 'mobile'],
       ['Preference 1', 'pref1'], ['Preference 2', 'pref2']]
      .map(function (r) { return barRow(r[0], have[r[1]], total, have[r[1]] === total ? 'green' : 'amber'); }).join('')
    : '<p class="notice">Assign students to a group first.</p>';

  // Duplicates and clashes
  var seen = {}, issues = [];
  ['1', '2'].forEach(function (p) {
    S.phases[p].forEach(function (grp) {
      grp.slots.forEach(function (slot) {
        if (!slot.index) return;
        var k = p + '|' + slot.index;
        if (seen[k]) issues.push('Index ' + slot.index + ' appears more than once in Phase ' + p);
        seen[k] = true;
        if (slot.pref1 && slot.pref1 === slot.pref2) issues.push(slot.index + ' has the same area for both preferences');
      });
    });
  });

  host.innerHTML = '' +
    '<div class="grid-2">' +
      '<div class="panel"><div class="panel-head"><h2>Group fill</h2></div><div class="bars">' + fill + '</div></div>' +
      '<div class="panel"><div class="panel-head"><h2>Most requested areas</h2>' +
        '<span class="pill">1st = 1 pt, 2nd = ½ pt</span></div><div class="bars">' + demandHTML + '</div></div>' +
      '<div class="panel"><div class="panel-head"><h2>Demand by division</h2></div><div class="bars">' + divHTML + '</div></div>' +
      '<div class="panel"><div class="panel-head"><h2>Details recorded</h2>' +
        '<span class="pill">' + total + ' students</span></div><div class="bars">' + completeness + '</div></div>' +
    '</div>' +
    '<div class="panel"><div class="panel-head"><h2>Checks</h2></div>' +
      (issues.length
        ? '<div class="kv">' + issues.map(function (i) { return '<div class="kv-row"><span>' + esc(i) + '</span><span>⚠</span></div>'; }).join('') + '</div>'
        : '<p class="notice">No duplicate indexes and no repeated preferences.</p>') +
    '</div>';
}

/* ================================================================== */
/* Render entry point                                                 */
/* ================================================================== */

function render() {
  $('#statTotal').textContent = S.students.length;
  $('#statPool').textContent  = poolFor(S.phase).length;
  $('#statP1').textContent    = assignedCount('1');
  $('#statP2').textContent    = assignedCount('2');

  $('#viewBoard').hidden   = S.view !== 'board';
  $('#viewSheet').hidden   = S.view !== 'sheet';
  $('#viewRoster').hidden  = S.view !== 'roster';
  $('#viewSummary').hidden = S.view !== 'summary';

  if (S.view === 'board')   renderBoard();
  if (S.view === 'sheet')   renderSheet();
  if (S.view === 'roster')  renderRoster();
  if (S.view === 'summary') renderSummary();
}

/* ================================================================== */
/* Location dropdowns                                                 */
/* ================================================================== */

var LOC_OPTIONS = '';
var AREA_SET = {};

function buildLocationOptions() {
  var groups = [], byKey = {};
  AREA_SET = {};

  S.locations.forEach(function (l) {
    var key = l.division + ' · ' + l.province;
    if (!byKey[key]) { byKey[key] = []; groups.push(key); }
    byKey[key].push(l.area);
    AREA_SET[l.area] = l;
  });

  // Grouped <optgroup> markup for the detail form, where the division and
  // province context is worth the extra weight.
  LOC_OPTIONS = groups.map(function (key) {
    return '<optgroup label="' + esc(key) + '">' +
      byKey[key].map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join('') +
      '</optgroup>';
  }).join('');

  $('#fPref1').innerHTML = '<option value="">— none —</option>' + LOC_OPTIONS;
  $('#fPref2').innerHTML = '<option value="">— none —</option>' + LOC_OPTIONS;

  // Flat datalist for the spreadsheet grid.
  $('#areaList').innerHTML = S.locations.map(function (l) {
    return '<option value="' + esc(l.area) + '">' + esc(l.division + ' · ' + l.province) + '</option>';
  }).join('');
}

function buildIndexDatalist() {
  $('#studentIndexes').innerHTML = S.students.map(function (st) {
    return '<option value="' + esc(st.index) + '">' + esc(st.name) + '</option>';
  }).join('');
}

/* ================================================================== */
/* Modal                                                              */
/* ================================================================== */

function openSlotForm(phase, g, s) {
  var slot = S.phases[phase][g].slots[s];
  S.editing = { phase: phase, g: g, s: s };
  $('#modalTitle').textContent = 'Student details';
  $('#modalSub').textContent = 'Phase ' + phase + ' · ' + S.phases[phase][g].name + ' · slot ' + (s + 1);
  fillForm(slot);
  $('#btnClear').hidden = false;
  showModal();
}

function openPoolForm(index) {
  var st = studentByIndex(index);
  if (!st) return;
  S.editing = { pool: index };
  $('#modalTitle').textContent = 'Student details';
  $('#modalSub').textContent = 'Unassigned · not yet in a group';
  fillForm({ index: st.index, name: st.name, title: 'Mr.', nic: '', email: '', mobile: '', pref1: '', pref2: '' });
  $('#btnClear').hidden = true;
  showModal();
}

function fillForm(slot) {
  $('#fIndex').value  = slot.index || '';
  $('#fTitle').value  = slot.title || 'Mr.';
  $('#fName').value   = slot.name || '';
  $('#fNic').value    = slot.nic || '';
  $('#fEmail').value  = slot.email || '';
  $('#fMobile').value = slot.mobile || '';
  $('#fPref1').value  = slot.pref1 || '';
  $('#fPref2').value  = slot.pref2 || '';
  validateForm();
}

function showModal() {
  $('#modal').hidden = false;
  setTimeout(function () { $('#fIndex').focus(); }, 30);
}

function closeModal() {
  $('#modal').hidden = true;
  S.editing = null;
}

function validateForm() {
  var ok = true;
  [['fNic', 'nic', 'hintNic'], ['fMobile', 'mobile', 'hintMobile'], ['fEmail', 'email', 'hintEmail']]
    .forEach(function (t) {
      var el = $('#' + t[0]), hint = $('#' + t[2]);
      var res = checkField(t[1], el.value);
      el.classList.toggle('is-bad', !res.ok);
      hint.textContent = res.note;
      hint.className = 'hint' + (res.ok ? (res.note ? ' good' : '') : ' bad');
      if (!res.ok) ok = false;
    });

  var p1 = $('#fPref1').value, p2 = $('#fPref2').value;
  var ph = $('#hintPref');
  if (p1 && p1 === p2) {
    ph.textContent = 'Both preferences point at the same area. Pick a different second choice.';
    ph.className = 'hint bad';
    ok = false;
  } else {
    ph.textContent = '';
    ph.className = 'hint';
  }
  return ok;
}

function saveForm() {
  if (!validateForm()) { toast('Fix the highlighted fields first.', true); return; }

  var index = $('#fIndex').value.trim();
  var name  = $('#fName').value.trim();
  if (!index) { toast('A student index is required.', true); return; }

  var data = {
    index:  index,
    title:  $('#fTitle').value,
    name:   name,
    nic:    $('#fNic').value.trim(),
    email:  $('#fEmail').value.trim(),
    mobile: $('#fMobile').value.trim(),
    pref1:  $('#fPref1').value,
    pref2:  $('#fPref2').value
  };

  // Keep the master student list in step.
  var st = studentByIndex(index);
  if (!st) S.students.push({ index: index, name: name });
  else if (name) st.name = name;
  buildIndexDatalist();

  if (S.editing && S.editing.pool) {
    // Editing someone still in the pool — only the list name is persisted.
    closeModal(); markDirty(); render();
    toast('Saved. Drag ' + index + ' into a group to record the rest.');
    return;
  }

  var e = S.editing;
  var slots = S.phases[e.phase][e.g].slots;

  // One slot per student per phase.
  placementsOf(index).forEach(function (p) {
    if (p.phase === e.phase && !(p.g === e.g && p.s === e.s)) clearSlot(e.phase, p.g, p.s, true);
  });

  slots[e.s] = data;
  closeModal(); markDirty(); render();
  toast('Details saved for ' + index + '.');
}

/* ================================================================== */
/* Export                                                             */
/* ================================================================== */

function exportCSV(phase) {
  var head = ['#', 'Group', 'Index', 'Title', 'Name', 'NIC', 'Email', 'Mobile Number',
              'Distribution Location-Preference1', 'Distribution Location-Preference2'];
  var lines = [head], n = 0;

  S.phases[phase].forEach(function (grp) {
    grp.slots.forEach(function (slot) {
      n++;
      lines.push([n, grp.name, slot.index, slot.title, slot.name, slot.nic,
                  slot.email, slot.mobile, slot.pref1, slot.pref2]);
    });
  });

  var csv = lines.map(function (row) {
    return row.map(function (c) {
      c = String(c == null ? '' : c);
      return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
    }).join(',');
  }).join('\r\n');

  var url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  var a = document.createElement('a');
  a.href = url;
  a.download = 'Student_Data-Phase' + phase + '.csv';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

/* ================================================================== */
/* Events                                                             */
/* ================================================================== */

function wire() {
  // Tabs
  $$('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      $$('.tab').forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      S.view = btn.dataset.view;
      render();
    });
  });

  // Phase switch
  $$('#phaseSwitch .seg').forEach(function (btn) {
    btn.addEventListener('click', function () {
      $$('#phaseSwitch .seg').forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      S.phase = btn.dataset.phase;
      S.picked = null;
      render();
    });
  });

  // Search
  var t;
  $('#search').addEventListener('input', function (e) {
    clearTimeout(t);
    var v = e.target.value.trim().toLowerCase();
    t = setTimeout(function () { S.search = v; render(); }, 140);
  });

  $('#btnAuto').addEventListener('click', autoAllocate);
  $('#btnAdd').addEventListener('click', addStudent);

  // Banner
  $('#bannerReload').addEventListener('click', function () {
    apiGet('state').then(function (st) {
      if (st && st.ok) { adoptState(st); toast('Loaded the sheet version.'); setSync('In sync', 'pill-ok'); }
    });
  });
  $('#bannerKeep').addEventListener('click', function () {
    $('#banner').hidden = true;
    S.conflict = false;
    save().then(function () { poll(); });
  });

  // Modal
  $$('#modal [data-close]').forEach(function (el) { el.addEventListener('click', closeModal); });
  $('#btnSaveStudent').addEventListener('click', saveForm);
  $('#btnClear').addEventListener('click', function () {
    var e = S.editing;
    if (!e || e.pool) return;
    clearSlot(e.phase, e.g, e.s);
    closeModal();
    toast('Slot cleared. The student is back in the pool.');
  });
  ['fNic', 'fMobile', 'fEmail', 'fPref1', 'fPref2'].forEach(function (id) {
    $('#' + id).addEventListener('input', validateForm);
    $('#' + id).addEventListener('change', validateForm);
  });
  $('#fIndex').addEventListener('change', function () {
    var st = studentByIndex($('#fIndex').value.trim());
    if (st && !$('#fName').value.trim()) $('#fName').value = st.name;
  });
  $('#studentForm').addEventListener('submit', function (e) { e.preventDefault(); saveForm(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) closeModal();
      else if (S.picked) { S.picked = null; render(); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });

  // Delegated clicks on the views
  $('#main').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (btn) {
      var a = btn.dataset;
      if (a.act === 'edit')         { openSlotForm(a.phase, +a.g, +a.s); return; }
      if (a.act === 'edit-pool')    { openPoolForm(a.index); return; }
      if (a.act === 'clear')        { clearSlot(a.phase, +a.g, +a.s); return; }
      if (a.act === 'slot-plus')    { addSlot(a.phase, +a.g); return; }
      if (a.act === 'slot-minus')   { removeEmptySlot(a.phase, +a.g); return; }
      if (a.act === 'add-student')  { addStudent(); return; }
      if (a.act === 'export')       { exportCSV(a.phase); return; }
      if (a.act === 'roster-edit')  { openSlotForm(a.phase, +a.g, +a.s); return; }
      if (a.act === 'roster-assign'){ openPoolForm(a.index); return; }
      if (a.act === 'roster-unassign') { clearSlot(a.phase, +a.g, +a.s); return; }
      if (a.act === 'roster-delete') { deleteStudent(a.index); return; }
      if (a.act === 'roster-sort-direction') { S.rosterAsc = !S.rosterAsc; renderRoster(); return; }
    }

    // Click a pool card to pick it up, then click a slot to place it.
    var poolCard = e.target.closest('.card[data-from="pool"]');
    if (poolCard) {
      S.picked = (S.picked === poolCard.dataset.index) ? null : poolCard.dataset.index;
      render();
      return;
    }

    var slot = e.target.closest('.slot');
    if (slot && S.picked) {
      assign(S.picked, slot.dataset.phase, +slot.dataset.g, +slot.dataset.s);
      S.picked = null;
      return;
    }
    if (slot) { openSlotForm(slot.dataset.phase, +slot.dataset.g, +slot.dataset.s); return; }

    var filled = e.target.closest('.card[data-from="slot"]');
    if (filled) openSlotForm(filled.dataset.phase, +filled.dataset.g, +filled.dataset.s);
  });

  // Inline editing in the spreadsheet view
  $('#main').addEventListener('input', onCellEdit);
  $('#main').addEventListener('change', onCellEdit);
  $('#main').addEventListener('input', onRosterControl);
  $('#main').addEventListener('change', onRosterControl);

  wireDnd();
}

function onRosterControl(e) {
  var el = e.target;
  if (!el.dataset || !el.dataset.rosterControl) return;
  var key = el.dataset.rosterControl;
  if (key === 'search') S.rosterSearch = el.value.trim().toLowerCase();
  if (key === 'phase') S.rosterPhase = el.value;
  if (key === 'group') S.rosterGroup = el.value;
  if (key === 'sort') S.rosterSort = el.value;
  clearTimeout(onRosterControl._timer);
  onRosterControl._timer = setTimeout(renderRoster, key === 'search' ? 120 : 0);
}

function onCellEdit(e) {
  var el = e.target;
  if (!el.classList || !el.classList.contains('cell')) return;
  var d = el.dataset;
  var slot = S.phases[d.phase][+d.g].slots[+d.s];
  slot[d.key] = el.value;

  if (d.key === 'index') {
    var st = studentByIndex(el.value.trim());
    if (st && !slot.name) slot.name = st.name;
  }
  var col = COLS.filter(function (c) { return c.key === d.key; })[0];
  if (col && col.check) el.classList.toggle('is-bad', !checkField(col.check, el.value).ok);
  if (col && col.loc)   el.classList.toggle('is-bad', !!el.value && !AREA_SET[el.value]);

  markDirty();
  $('#statPool').textContent = poolFor(S.phase).length;
  $('#statP1').textContent   = assignedCount('1');
  $('#statP2').textContent   = assignedCount('2');
}

/* ---------- Drag and drop ---------- */

function wireDnd() {
  var main = $('#main');

  main.addEventListener('dragstart', function (e) {
    var card = e.target.closest('.card');
    if (!card) return;
    var d = card.dataset;
    var payload = d.from === 'pool'
      ? { from: 'pool', index: d.index }
      : { from: 'slot', phase: d.phase, g: +d.g, s: +d.s };
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
  });

  main.addEventListener('dragend', function (e) {
    var card = e.target.closest('.card');
    if (card) card.classList.remove('is-dragging');
    $$('.is-over').forEach(function (el) { el.classList.remove('is-over'); });
  });

  main.addEventListener('dragover', function (e) {
    var target = e.target.closest('[data-drop]');
    if (!target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var slot = e.target.closest('.slot');
    $$('.is-over').forEach(function (el) { el.classList.remove('is-over'); });
    (slot || target).classList.add('is-over');
  });

  main.addEventListener('dragleave', function (e) {
    var target = e.target.closest('[data-drop], .slot');
    if (target) target.classList.remove('is-over');
  });

  main.addEventListener('drop', function (e) {
    var target = e.target.closest('[data-drop]');
    if (!target) return;
    e.preventDefault();
    $$('.is-over').forEach(function (el) { el.classList.remove('is-over'); });

    var payload;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }

    // Dropped back onto the pool: free the slot.
    if (target.dataset.drop === 'pool') {
      if (payload.from === 'slot') clearSlot(payload.phase, payload.g, payload.s);
      return;
    }

    var slotEl = e.target.closest('.slot');
    var to = {
      phase: slotEl ? slotEl.dataset.phase : target.dataset.phase,
      g:     slotEl ? +slotEl.dataset.g : +target.dataset.g,
      s:     slotEl ? +slotEl.dataset.s : -1
    };

    if (payload.from === 'pool') assign(payload.index, to.phase, to.g, to.s);
    else moveSlot(payload, to);
  });
}

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

function bootDemo() {
  var seed = window.SEED_DATA || { students: [], locations: [], phases: { '1': [], '2': [] } };
  S.students  = clone(seed.students);
  S.locations = clone(seed.locations);
  S.phases    = clone(seed.phases);
  buildLocationOptions();
  buildIndexDatalist();
  render();
  setSync('Demo mode — no sheet connected', 'pill-warn');
}

function boot() {
  wire();

  if (DEMO) {
    bootDemo();
    console.info('[board] Running on bundled sample data. Set API_URL in config.js to connect a Google Sheet.');
    return;
  }

  setSync('Connecting…', 'pill-busy');
  apiGet('state').then(function (res) {
    if (!res || !res.ok) throw new Error((res && res.error) || 'The web app did not return data.');
    adoptState(res);
    setSync('In sync', 'pill-ok');
    setInterval(poll, POLL);
    window.addEventListener('beforeunload', function (e) {
      if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }).catch(function (err) {
    console.error(err);
    setSync('Cannot reach the sheet', 'pill-error');
    toast('Falling back to sample data: ' + err.message, true);
    bootDemo();
  });
}

boot();

})();
