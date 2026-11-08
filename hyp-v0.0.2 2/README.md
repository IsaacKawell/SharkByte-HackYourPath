# SharkByte: HackYourPath

A transfer planner for Miami Dade College students.

- **Planner (`/`)**: pick courses by term, compare universities, check progress, and ask the AI advisor or the Nom Nom chat.
- **Degree-audit advisor (`/advisor.html`)**: enter the courses you have taken, pick a transfer goal, and chat with a Swarms AI agent. The audit itself is plain code, so the AI explains requirements but never decides them.
- **Plan Notes table**: save any Nom Nom message to an editable, sortable table (see below).
- **Schedule builder (`POST /api/schedule`)**: Gemini picks real MDC class sections from the verified catalog; the server then re-checks the answer (no invented sections, no work-hour clashes, credit limit).

## Run it

1. Install Node.js 18 or newer.
2. `npm install` (installs the optional Gemini SDK; the app still starts without it).
3. Copy `.env.example` to `.env` and add your keys. **Never commit `.env`.**
4. `npm start`, then open http://localhost:3000

`npm test` runs the automated tests (no keys or network needed).

| Variable | Needed for |
|---|---|
| `SWARMS_API_KEY` | AI advisor, Nom Nom chat, audit chat |
| `GEMINI_API_KEY` | schedule builder only |
| `PORT`, `RATE_LIMIT_PER_10_MIN` | optional |

API keys live only on the server. The browser never sees them.

## Layout

```
server.js            routes, static files, rate limiting
src/
  advisor.js         prompts + the audit chat + planner AI modes
  audit.js           degree-audit engine (no AI)
  scheduler.js       Gemini schedule builder + server-side validation
  swarms.js          the one place that calls the Swarms API
  env.js, errors.js  small helpers
data/
  aa.json            MDC Associate in Arts, Fall 2026
  courses.json       course names + the prerequisites we are sure of
  transfer/          one file per school + major (FIU CS, FSU CS, "stay at MDC")
  schedules/
    catalog.json     compiled class sections used by the scheduler
    raw/             the original per-course, per-term section files it was built from
public/              the browser app (index.html, advisor.html, assets/)
  notes/             Plan Notes table: core logic, UI, chat bridge, styles
sources/             the official PDFs the requirement data came from
examples/            sample scheduler input
test/                automated tests
```

Add a school or major: drop a JSON file in `data/transfer/` (copy `fiu-cs.json`). The audit chat's dropdown fills itself.

## API

| Route | Body | Returns |
|---|---|---|
| `GET /api/health` | | which keys are set |
| `GET /api/targets` | | transfer goals for the dropdown |
| `POST /api/chat` | `{ message, history, target, courses }` | `{ reply, recognized, unrecognized }` |
| `POST /api/ask` | `{ mode: "advisor"\|"mascot", message, history, context }` | `{ reply }` |
| `POST /api/schedule` | see `examples/schedule-input.json` | schedule + `validationStatus`, `conflicts`, `warnings` |
| `POST /api/replan` | `{ input, change }` | what-if schedule |

## Plan Notes ("Add to table")

Under every Nom Nom message there is an optional **+ Add to table** button. It saves that message (and, for a reply, the question it answered) as a row in an interactive table in the middle of the screen. Open the table any time with **My Notes** in the top bar.

In the table a student can tick items off, rename a note, edit its text, change its category (General, Courses, Requirements, Deadlines, To-do) and school (MDC, FIU, UF, FSU), search, filter, sort by any column, delete (with Undo), and export everything as CSV. Category and school are suggested from the text by simple rules (`classify` in `notes-core.js`); the student can always change them.

```
public/notes/
  notes-core.js    data rules, search/sort/filter, CSV, store + storage adapter (no DOM; unit-tested)
  notes-ui.js      the table (DOM only; user text is never inserted as HTML)
  notes-bridge.js  watches the chat log, adds the buttons and the "My Notes" launcher
  notes-init.js    wires the three together
  notes.css        styles (light + dark, phone layout)
```

- **Nom Nom is untouched.** The bridge only observes `#chat-log` and adds a sibling button under each bubble.
- **Storage.** Notes live in this browser's `localStorage` under `sharkbyte-notes`, wrapped as `{ v: 1, notes: [...] }`. Every note is validated on load, so damaged or older data cannot break the page. Limit: 500 notes.
- **Moving to a server later.** The store only needs `{ load(), save(text) }`. Write a server-backed adapter and pass it to `createStore({ adapter })` in `notes-init.js`; the table and chat code do not change. A real adapter needs student accounts first, so it is not built yet.
- **Note shape:** `id, createdAt, updatedAt, title, body, question, source, category, school, done`.
- **CSV safety.** Cells that start with `= + - @` are prefixed so spreadsheets do not run them as formulas.
- **Tests:** `test/notes-core.test.js` (run with `npm test`).

## Data caveats (read before presenting)

- FIU data is from the 2026-2027 MDC transfer guide in `sources/`; AA data is from the Fall 2026 pathway guide.
- FSU data comes from FSU's published guide, which is the **Tallahassee CC** version. Confirm MDC equivalents.
- UF, UCF, MIT, Georgia Tech and UM entries in the planner are marked "Estimated" and are **not verified**.
- `courses.json` lists only prerequisites we are confident about; the rest are reported as unknown.
- Class sections in `data/schedules` are a snapshot (Spring and Summer 2027). Seats and sections change.

## Deploying

Any Node host works (Render, Railway, Fly). Build command `npm install`, start command `npm start`, and set the environment variables from the table above in the host's dashboard.
