const test = require("node:test");
const assert = require("node:assert");
const core = require("../public/notes/notes-core.js");

// Deterministic clock and ids so tests never depend on real time.
function harness(initial) {
  let t = Date.parse("2026-11-08T12:00:00Z");
  let n = 0;
  const now = () => new Date((t += 1000)).toISOString();
  const uid = () => "id" + ++n;
  const adapter = core.memoryAdapter(initial);
  return { adapter, store: core.createStore({ adapter, now, uid }), now, uid };
}

test("classify: suggests category and a school only when exactly one is named", () => {
  assert.deepStrictEqual(core.classify("The FIU application deadline is Feb 1"), { category: "Deadlines", school: "FIU" });
  assert.strictEqual(core.classify("MAC 2311 is required before you transfer").category, "Requirements");
  assert.strictEqual(core.classify("Take MAC 2312 in spring").category, "Courses");
  assert.strictEqual(core.classify("Compare FIU and UF").school, "", "two schools named: leave blank");
  assert.deepStrictEqual(core.classify("hello there"), { category: "General", school: "" });
});

test("sanitizeNote: trims, clips, defaults, drops junk", () => {
  assert.strictEqual(core.sanitizeNote(null), null);
  assert.strictEqual(core.sanitizeNote({ body: "   " }), null);
  const long = "x".repeat(core.LIMITS.body + 50);
  const note = core.sanitizeNote({ body: long, category: "Hacking", school: "MIT", done: "yes", evil: "<script>" });
  assert.strictEqual(note.body.length, core.LIMITS.body);
  assert.ok(core.CATEGORIES.includes(note.category), "invalid category replaced");
  assert.strictEqual(note.school, "", "unknown school replaced");
  assert.strictEqual(note.done, false, "done must be a real boolean");
  assert.ok(!("evil" in note), "unknown fields dropped");
  assert.ok(note.title.length <= 80);
});

test("title comes from the question when there is one", () => {
  const { store } = harness();
  const r = store.add({ question: "What classes do I need for FIU CS?", body: "You need MAC 2311..." , source: "nomnom-reply" });
  assert.strictEqual(r.note.title, "What classes do I need for FIU CS?");
  assert.strictEqual(r.note.school, "FIU");
});

test("store: add / update / persist / reload", () => {
  const h = harness();
  const a = h.store.add({ body: "Apply by March 1", source: "nomnom-reply" }).note;
  assert.strictEqual(a.category, "Deadlines");
  assert.strictEqual(h.store.update(a.id, { done: true, category: "To-do", school: "FSU" }).note.done, true);
  assert.deepStrictEqual(h.store.update("nope", { done: true }), { ok: false, reason: "missing" });

  // Fields the UI must not change are ignored.
  h.store.update(a.id, { id: "hijack", createdAt: "2000-01-01T00:00:00Z", source: "manual", question: "x" });
  const kept = h.store.get(a.id);
  assert.strictEqual(kept.source, "nomnom-reply");
  assert.notStrictEqual(kept.createdAt, "2000-01-01T00:00:00Z");

  // A fresh store over the same storage sees the same data.
  const again = core.createStore({ adapter: h.adapter });
  assert.strictEqual(again.count(), 1);
  assert.strictEqual(again.list()[0].category, "To-do");
});

test("store: empty input is rejected and the cap is enforced", () => {
  const { store } = harness();
  assert.deepStrictEqual(store.add({ body: "  " }), { ok: false, reason: "empty" });
  for (let i = 0; i < core.MAX_NOTES; i++) store.add({ body: "note " + i });
  assert.strictEqual(store.isFull(), true);
  assert.deepStrictEqual(store.add({ body: "one more" }), { ok: false, reason: "full" });
});

test("store: remove then restore puts notes back where they were", () => {
  const { store } = harness();
  const ids = ["a", "b", "c"].map((b) => store.add({ body: b }).note.id); // list order: c, b, a
  const before = store.list().map((n) => n.body);
  const removed = store.remove(ids[1]);
  assert.strictEqual(store.count(), 2);
  store.restore(removed);
  assert.deepStrictEqual(store.list().map((n) => n.body), before);
  store.restore(removed); // restoring twice must not duplicate
  assert.strictEqual(store.count(), 3);
});

test("store: subscribers hear about changes; a failing save is reported", () => {
  let fail = false;
  const adapter = { load: () => null, save: () => !fail };
  const store = core.createStore({ adapter });
  const seen = [];
  const off = store.subscribe((list, err) => seen.push([list.length, err]));
  store.add({ body: "first" });
  fail = true;
  store.add({ body: "second" });
  off();
  store.add({ body: "third" });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0][1], null);
  assert.match(seen[1][1], /Could not save/);
});

test("parseStored survives bad, old, duplicate and future data", () => {
  assert.deepStrictEqual(core.parseStored("not json"), []);
  assert.deepStrictEqual(core.parseStored(null), []);
  assert.deepStrictEqual(core.parseStored(JSON.stringify({ v: 99, notes: [{ body: "x" }] })), [], "newer schema is left alone");
  const legacy = core.parseStored(JSON.stringify([{ id: "1", body: "old format" }, { id: "1", body: "dupe" }, 42, null]));
  assert.strictEqual(legacy.length, 1);
  const cap = core.parseStored(JSON.stringify({ v: 1, notes: Array.from({ length: core.MAX_NOTES + 20 }, (_, i) => ({ id: "n" + i, body: "b" + i })) }));
  assert.strictEqual(cap.length, core.MAX_NOTES);
});

test("filter and sort", () => {
  const { store } = harness();
  store.add({ body: "FIU deadline is Feb 1", title: "Zeta" });
  store.add({ body: "Take MAC 2311", title: "alpha" });
  store.add({ body: "UF needs PHY 2048", title: "Beta" });
  store.update(store.list()[0].id, { done: true });
  const all = store.list();

  assert.strictEqual(core.filterNotes(all, { query: "mac" }).length, 1);
  assert.strictEqual(core.filterNotes(all, { query: "  FIU " }).length, 1);
  assert.strictEqual(core.filterNotes(all, { hideDone: true }).length, 2);
  assert.strictEqual(core.filterNotes(all, { school: "UF" }).length, 1);
  assert.strictEqual(core.filterNotes(all, { category: "Courses", school: "FIU" }).length, 0);

  assert.deepStrictEqual(core.sortNotes(all, { key: "title", dir: "asc" }).map((n) => n.title), ["alpha", "Beta", "Zeta"], "case-insensitive");
  assert.strictEqual(core.sortNotes(all, { key: "createdAt", dir: "desc" })[0].title, "Beta");
  assert.strictEqual(core.sortNotes(all, { key: "not-a-column" }).length, 3, "bad key falls back safely");
  assert.strictEqual(all.length, 3, "inputs are never mutated");
});

test("CSV: quotes, newlines, and formula injection are handled", () => {
  assert.strictEqual(core.csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.strictEqual(core.csvCell("=HYPERLINK(\"http://x\")").startsWith("\"'="), true);
  assert.strictEqual(core.csvCell("+1+1"), "'+1+1");
  assert.strictEqual(core.csvCell("a\nb"), '"a\nb"');
  const { store } = harness();
  store.add({ title: "t", body: "=cmd|' /C calc'!A0", question: "q" });
  const csv = core.toCSV(store.list());
  assert.match(csv.split("\r\n")[0], /^Done,Topic,Note/);
  assert.ok(!/(^|,)=cmd/.test(csv), "no raw formula cell");
});
