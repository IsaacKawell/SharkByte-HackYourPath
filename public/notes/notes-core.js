/*
 * Plan Notes: core logic (no DOM, no globals).
 *
 * Everything the "Add to table" feature knows how to do lives here so it can be
 * unit-tested in Node (`npm test`) and reused by any UI. The same file loads in
 * the browser (as window.PlanNotesCore) and in Node (via require).
 *
 * Layers:
 *   notes-core.js    data rules, search/sort/filter, CSV, store + storage adapter
 *   notes-ui.js      the interactive table (DOM only)
 *   notes-bridge.js  connects the Nom Nom chat to the store
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlanNotesCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = "sharkbyte-notes";
  const MAX_NOTES = 500;
  const LIMITS = { title: 120, body: 8000, question: 2000 };

  const CATEGORIES = ["General", "Courses", "Requirements", "Deadlines", "To-do"];
  const SCHOOLS = ["", "MDC", "FIU", "UF", "FSU"];
  const SOURCES = ["nomnom-reply", "nomnom-user", "manual"];

  // ---------- small helpers ----------
  const clip = (value, max) => String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim().slice(0, max);
  const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const isoOrNow = (value, now) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : now());

  function defaultId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // ---------- classification (plain rules, no AI) ----------
  // Suggests a category and school so the table is useful without any editing.
  // The student can always change both; these are suggestions, not decisions.
  const CATEGORY_RULES = [
    ["Deadlines", /\b(deadline|due (on|by|date)|apply by|application (opens?|closes?)|priority date|by (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)/i],
    ["Requirements", /\b(requirement|prerequisite|prereq|minimum gpa|gpa of|grade of|must (be )?complet|required (for|before)|admission|transfer guide|a\.?a\.? degree)\b/i],
    ["To-do", /\b(next steps?|to-?do|you should|make sure|remember to|don'?t forget|schedule an? (appointment|meeting)|meet with (an )?advisor)\b/i],
    ["Courses", /\b[A-Z]{3}\s?\d{4}[A-Z]?\b|\b(course|class|section|semester|credits?|calculus|physics|chemistry|biology|python|java)\b/i],
  ];
  const SCHOOL_RULES = [
    ["FIU", /\bFIU\b|florida international/i],
    ["UF", /\bUF\b|university of florida/i],
    ["FSU", /\bFSU\b|florida state/i],
    ["MDC", /\bMDC\b|miami dade/i],
  ];

  function classify(text) {
    const t = String(text || "");
    let category = "General";
    for (const [name, re] of CATEGORY_RULES) {
      if (re.test(t)) { category = name; break; }
    }
    // Only guess a school when exactly one is named; otherwise leave it for the student.
    const hits = SCHOOL_RULES.filter(([, re]) => re.test(t)).map(([name]) => name);
    return { category, school: hits.length === 1 ? hits[0] : "" };
  }

  function deriveTitle(question, body) {
    const source = clip(question, LIMITS.question) || clip(body, LIMITS.body);
    const firstLine = source.split("\n").find((l) => l.trim()) || "Untitled note";
    const cut = firstLine.length > 80 ? firstLine.slice(0, 77).trimEnd() + "..." : firstLine;
    return cut;
  }

  // ---------- note shape ----------
  // Every note, whether new or loaded from storage, passes through here, so the
  // rest of the code can trust the shape. Unknown fields are dropped.
  function sanitizeNote(raw, { now = () => new Date().toISOString(), uid = defaultId } = {}) {
    if (!raw || typeof raw !== "object") return null;
    const body = clip(raw.body, LIMITS.body);
    const question = clip(raw.question, LIMITS.question);
    if (!body && !question && !clip(raw.title, LIMITS.title)) return null;
    const guess = classify(body + " " + question);
    const created = isoOrNow(raw.createdAt, now);
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 80) : uid(),
      createdAt: created,
      updatedAt: isoOrNow(raw.updatedAt, () => created),
      title: clip(raw.title, LIMITS.title) || deriveTitle(question, body),
      body,
      question,
      source: oneOf(raw.source, SOURCES, "manual"),
      category: oneOf(raw.category, CATEGORIES, guess.category),
      school: oneOf(raw.school, SCHOOLS, guess.school),
      done: raw.done === true,
    };
  }

  // Versioned envelope: { v, notes }. Older or damaged data never crashes the app.
  function parseStored(json, opts) {
    if (!json) return [];
    let data;
    try { data = JSON.parse(json); } catch { return []; }
    let list = [];
    if (Array.isArray(data)) list = data; // pre-envelope format
    else if (data && typeof data === "object" && Array.isArray(data.notes)) {
      if (typeof data.v === "number" && data.v > SCHEMA_VERSION) return []; // written by a newer app: don't guess
      list = data.notes;
    }
    const seen = new Set();
    const out = [];
    for (const raw of list.slice(0, MAX_NOTES)) {
      const note = sanitizeNote(raw, opts);
      if (note && !seen.has(note.id)) { seen.add(note.id); out.push(note); }
    }
    return out;
  }
  const serialize = (notes) => JSON.stringify({ v: SCHEMA_VERSION, notes });

  // ---------- view logic: filter / sort ----------
  const SORTABLE = ["done", "title", "category", "school", "createdAt"];

  function filterNotes(notes, { query = "", category = "", school = "", hideDone = false } = {}) {
    const q = query.trim().toLowerCase();
    return notes.filter((n) => {
      if (hideDone && n.done) return false;
      if (category && n.category !== category) return false;
      if (school && n.school !== school) return false;
      if (q && !(n.title + "\n" + n.body + "\n" + n.question).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function sortNotes(notes, { key = "createdAt", dir = "desc" } = {}) {
    const k = SORTABLE.includes(key) ? key : "createdAt";
    const sign = dir === "asc" ? 1 : -1;
    const val = (n) => (k === "done" ? Number(n.done) : k === "createdAt" ? Date.parse(n.createdAt) : String(n[k]).toLowerCase());
    // Array.prototype.sort is stable, and createdAt breaks ties so order is deterministic.
    return notes.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if (x < y) return -1 * sign;
      if (x > y) return 1 * sign;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
  }

  // ---------- CSV export ----------
  // Cells starting with = + - @ are prefixed with ' so Excel/Sheets treat them as
  // text, not formulas (CSV injection). Chat text is untrusted, so this matters.
  function csvCell(value) {
    let s = String(value == null ? "" : value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(notes) {
    const header = ["Done", "Topic", "Note", "Question asked", "Category", "School", "Added"];
    const rows = notes.map((n) => [n.done ? "Yes" : "No", n.title, n.body, n.question, n.category, n.school, n.createdAt]);
    return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  }

  // ---------- storage adapters ----------
  // The store only needs { load(): string|null, save(string) }. Today that is
  // localStorage; a server-backed adapter (per-user, once there are accounts)
  // can replace it without touching the store, UI or chat bridge.
  function localStorageAdapter(key = STORAGE_KEY, storage) {
    const area = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    return {
      load() { try { return area ? area.getItem(key) : null; } catch { return null; } },
      save(text) { try { if (area) area.setItem(key, text); return true; } catch { return false; } },
    };
  }
  function memoryAdapter(initial = null) {
    let text = initial;
    return { load: () => text, save: (t) => { text = t; return true; } };
  }

  // ---------- the store ----------
  function createStore({ adapter = localStorageAdapter(), now = () => new Date().toISOString(), uid = defaultId } = {}) {
    const opts = { now, uid };
    let notes = parseStored(adapter.load(), opts);
    let lastError = null;
    const listeners = new Set();

    function commit() {
      const ok = adapter.save(serialize(notes));
      lastError = ok === false ? "Could not save to this browser (storage full or blocked)." : null;
      listeners.forEach((fn) => { try { fn(api.list(), lastError); } catch (e) { console.error(e); } });
    }

    const api = {
      list: () => notes.slice(),
      get: (id) => notes.find((n) => n.id === id) || null,
      has: (id) => notes.some((n) => n.id === id),
      count: () => notes.length,
      error: () => lastError,
      isFull: () => notes.length >= MAX_NOTES,

      add(input) {
        if (notes.length >= MAX_NOTES) return { ok: false, reason: "full" };
        const note = sanitizeNote({ ...input, id: undefined, createdAt: undefined, updatedAt: undefined, done: false }, opts);
        if (!note) return { ok: false, reason: "empty" };
        notes = [note, ...notes];
        commit();
        return { ok: true, note };
      },

      update(id, patch) {
        const i = notes.findIndex((n) => n.id === id);
        if (i < 0) return { ok: false, reason: "missing" };
        const allowed = {};
        for (const k of ["title", "body", "category", "school", "done"]) if (k in patch) allowed[k] = patch[k];
        const merged = sanitizeNote({ ...notes[i], ...allowed, updatedAt: now() }, opts);
        if (!merged) return { ok: false, reason: "empty" };
        notes = notes.slice();
        notes[i] = { ...merged, id: notes[i].id, createdAt: notes[i].createdAt, source: notes[i].source, question: notes[i].question };
        commit();
        return { ok: true, note: notes[i] };
      },

      // Returns the removed notes plus their positions so the UI can offer Undo.
      remove(ids) {
        const set = new Set([].concat(ids));
        const removed = [];
        notes.forEach((n, index) => { if (set.has(n.id)) removed.push({ note: n, index }); });
        if (!removed.length) return [];
        notes = notes.filter((n) => !set.has(n.id));
        commit();
        return removed;
      },

      restore(removed) {
        const next = notes.slice();
        for (const { note, index } of removed.slice().sort((a, b) => a.index - b.index)) {
          if (next.some((n) => n.id === note.id) || next.length >= MAX_NOTES) continue;
          next.splice(Math.min(index, next.length), 0, note);
        }
        notes = next;
        commit();
      },

      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    return api;
  }

  return {
    SCHEMA_VERSION, STORAGE_KEY, MAX_NOTES, LIMITS, CATEGORIES, SCHOOLS, SOURCES, SORTABLE,
    classify, deriveTitle, sanitizeNote, parseStored, serialize,
    filterNotes, sortNotes, csvCell, toCSV,
    localStorageAdapter, memoryAdapter, createStore,
  };
});
