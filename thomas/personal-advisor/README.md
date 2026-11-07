# SharkByte: MDC Pathway Advisor

A chat app that checks a student's courses against the MDC Associate in Arts and a chosen
transfer program, then uses a Swarms AI agent to explain the results.

## Run it

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env` and put your Swarms API key after `SWARMS_API_KEY=`.
3. `npm start` (or `node server.js`), then open http://localhost:3000

Never commit `.env`. It is listed in `.gitignore`.

## Layout

```
server.js         routes + the Swarms call
src/audit.js      degree audit engine (plain code, no AI)
data/             requirements as JSON (edit these, not the code)
  aa.json           MDC AA, effective Fall 2026
  courses.json      course names + prerequisites we are sure of
  transfer/         one file per school + major (fiu-cs.json, fsu-cs.json)
public/           the browser app (index.html, style.css, script.js)
sources/          the official PDFs the data came from
```

## How it works

1. The browser sends the message, history, transfer goal and the student's course list.
2. `src/audit.js` compares the courses to `data/aa.json` and the chosen `data/transfer/*.json`.
3. The server sends the audit result and requirement notes to the Swarms agent, which only explains them.

Add a school or major by dropping a new JSON file into `data/transfer/`. The dropdown fills itself.

## Data caveats

- Requirements come from the PDFs in `sources/` and FSU's published transfer guide. Verify against official catalogs before relying on them.
- The FSU guide is the Tallahassee CC version. Confirm MDC equivalents.
- `courses.json` lists only prerequisites we are confident about; the rest are reported as unknown.
