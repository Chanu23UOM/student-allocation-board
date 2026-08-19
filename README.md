# Student Allocation & Grouping Board

A static dashboard for assigning students into Phase 1 / Phase 2 groups and recording
distribution-location preferences, backed by your Google Sheet.

GitHub Pages can only serve static files — it cannot hold a secret or talk to Google on
your behalf. So the sheet access lives in a **Google Apps Script web app** that you deploy
from the spreadsheet itself, and the Pages site calls it. Nothing else to host, no server
to pay for.

```
GitHub Pages (index.html)  ──fetch──►  Apps Script /exec  ──►  Google Sheet
        ▲                                                          │
        └──────────── polls every 6s for a new revision ◄──────────┘
```

---

## What it does

**Assignment board** — Unassigned pool on the left, one column per group. Drag a student
onto a slot, or click the card then click the slot (works on touch). Drag a card back to
the pool to free the slot. Each group's slot count is shown as `filled / total`.

**Student details form** — Index, title, name, NIC, email, mobile, and two preference
locations picked from the *Distribution Locations* area list. NIC, mobile and email are
validated as you type; picking the same area twice is blocked.

**Spreadsheet view** — The same data as an editable grid, one table per phase, laid out in
the same column order as the sheet. Exports to CSV.

**Summary breakdown** — Group fill, most-requested areas (1st choice = 1 point, 2nd = ½),
demand by division, how complete the contact details are, and a checks panel for duplicate
indexes and repeated preferences.

**Live sync** — Every edit is saved back to the sheet about 1.5 seconds after you stop
typing. The page checks for a new revision every 6 seconds and reloads if someone else —
or someone typing directly into the sheet — has changed it. If you have unsaved edits when
that happens, you get a banner asking which version wins instead of losing your work.

---

## Notes on your data

Three things worth knowing before you start.

**The phase sheets are slot templates, not flat tables.** Each group header row is followed
by numbered rows that already carry a title — Phase 1 Group 1 is `Mr., Mr., Mr., Ms., Ms.,
Mr., Mr.`. That looks like a deliberate gender balance per group, so the app preserves it:
the title belongs to the slot, and moving a student between slots does not carry their
title along. Change it in the form if a slot's title is wrong for the person in it.

**There are fewer slots than students.** Phase 1 has 34 slots and Phase 2 has 32, which is
66 against 90 students in the list. Twenty-four students cannot be placed until you add
slots — use the `+` button in any group header.

**Column A repeats a number at every group boundary.** The original file has 7 in both
Group 1 and Group 2, 19 in both Group 3 and Group 4, and 25 in both Group 4 and Group 5.
That looks like a copy-paste artefact, so the app renumbers column A as a clean 1…N
sequence when it writes. If those repeats were intentional, say so and I'll preserve them.

---

## Part 1 — Set up the Google Sheet backend

**1. Open the workbook in Google Sheets.** If `B23_Internships.xlsx` is still an Excel file
in Drive, open it and choose **File → Save as Google Sheets**. The Apps Script editor is
only available on a native Google Sheet. Work in the converted copy from then on.

Confirm the four tabs are named exactly: `Student list`, `Student Data-Phase1`,
`Student Data-Phase2`, `Distribution Locations`. The script matches on these names.

**2. Open Apps Script.** In the spreadsheet: **Extensions → Apps Script**. Delete the
`function myFunction() {}` stub in `Code.gs`.

**3. Paste the backend.** Copy the whole of `apps-script/Code.gs` from this repo into the
editor.

**4. Set your token.** Near the top, change:

```js
API_TOKEN: 'change-this-to-a-long-random-string',
```

to something long and random. You'll paste the same value into `config.js` later. Save with
Ctrl/Cmd+S.

**5. Grant permissions.** In the function dropdown at the top, pick `setup`, then click
**Run**. Google will ask you to authorise. You'll see "Google hasn't verified this app" —
click **Advanced → Go to (project name) → Allow**. That warning is expected for a script
you wrote yourself. Check the execution log; it should print your student and location
counts.

**6. Deploy as a web app.** Click **Deploy → New deployment**. Click the gear next to
"Select type" and choose **Web app**. Then:

- Description: `board v1`
- Execute as: **Me**
- Who has access: **Anyone**

"Anyone" is required — your Pages site calls this without a Google login. Click **Deploy**
and copy the **Web app URL**. It ends in `/exec`.

> **Every time you edit `Code.gs` afterwards**, you must publish a new version:
> **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. The `/exec`
> URL stays the same but keeps serving the old code until you do this. This catches
> almost everyone at least once.

**Optional — the Drive folder picker.** Set `DRIVE_FOLDER_ID` to the ID from your folder's
URL (`drive.google.com/drive/folders/THIS_PART`) and `GET ?action=files` will list the
spreadsheets in it. Useful if you run separate workbooks per intake.

---

## Part 2 — Put the site on GitHub Pages

**1. Create the repo.** On GitHub: **New repository**, name it something like
`student-allocation-board`, set it to **Public**, and create it. Public is required for
Pages on a free account.

**2. Upload the files.** On the empty repo page, click **uploading an existing file**, drag
in everything from this folder, and commit to `main`. Keep the structure:

```
index.html
config.js
assets/styles.css
assets/app.js
assets/seed.js
apps-script/Code.gs
.nojekyll
```

Or, from a terminal:

```bash
git init
git add .
git commit -m "Student allocation board"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/student-allocation-board.git
git push -u origin main
```

**3. Point the site at your web app.** Open `config.js` on GitHub, click the pencil, and
fill in both values:

```js
window.APP_CONFIG = {
  API_URL:   'https://script.google.com/macros/s/AKfy.../exec',
  API_TOKEN: 'the-same-token-you-set-in-Code.gs',
  POLL_MS:    6000,
  AUTOSAVE_MS: 1500
};
```

Commit the change. The two tokens must match character for character.

**4. Turn on Pages.** **Settings → Pages**. Under "Build and deployment", set Source to
**Deploy from a branch**, branch `main`, folder `/ (root)`. Save. After a minute or two
your site is at `https://YOUR-USERNAME.github.io/student-allocation-board/`.

**5. Check it.** Open the site. The pill in the top-right should read **In sync**. Move a
student into a group and watch the row appear in `Student Data-Phase1`.

---

## If something doesn't work

**Pill says "Cannot reach the sheet"** — Open the browser console (F12). A CORS or opaque
network error almost always means the deployment's access is set to "Only myself" rather
than "Anyone". Re-check step 6 above.

**"Bad API token"** — The strings in `config.js` and `Code.gs` differ. Watch for a trailing
space or a smart quote.

**"Sheet not found"** — A tab has been renamed. Either rename it back or update
`CONFIG.SHEETS` in `Code.gs` and redeploy a new version.

**Edits don't reach the sheet** — You changed `Code.gs` but didn't publish a new version.
See the callout in step 6.

**The site loads with sample data and says "Demo mode"** — `API_URL` in `config.js` is still
empty, or GitHub Pages is serving a cached copy. Hard-refresh with Ctrl/Cmd+Shift+R.

**Changes typed directly into the sheet take a few seconds to show** — That's expected. The
script uses Drive's last-modified timestamp to notice outside edits, and Drive updates it
with a short lag. Dashboard edits appear on other screens within about 6 seconds.

---

## About security

This is worth being clear about: **`config.js` is public.** Anyone who opens your Pages site
can view its source, read the token, and use it to read or write your sheet. The token stops
casual passers-by, not anyone who looks.

For a coursework roster shared inside a batch that's usually fine. If it isn't:

- Make the repo private and use **GitHub Pages for private repos**, which needs a paid plan.
- Or set the deployment's access to **Anyone with a Google account** and open the site while
  signed in — this blocks anonymous access but needs users to authorise the script once.
- Or run the page locally (`python3 -m http.server`) and skip Pages entirely.

Don't put anything in the sheet you wouldn't hand to a stranger. NIC numbers and mobile
numbers are personal data, so the third option is the safer default for real student records.

---

## Running it without a sheet

Leave `API_URL` empty and the board loads `assets/seed.js`, a snapshot of your workbook —
90 students, 62 areas, and both phase layouts. Everything works except saving, and the
pill reads "Demo mode". Useful for showing the interface before you wire up the backend.

## Keyboard

`Esc` closes the form or drops the picked-up card. `Ctrl/Cmd+S` forces an immediate save.
