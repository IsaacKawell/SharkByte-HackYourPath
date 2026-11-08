const test = require("node:test");
const assert = require("node:assert");
const { parseCourses, auditLayer } = require("../src/audit");
const catalog = require("../data/courses.json").courses;
const aa = require("../data/aa.json");
const fiu = require("../data/transfer/fiu-cs.json");

const group = (r, start) => r.requirements.find((q) => q.group.startsWith(start));

test("grades, in-progress and withdrawals are read correctly", () => {
  const r = parseCourses("MAC2311 (B), mac 2312 (IP), BSC 2010 (W), BSC 2010 (D)");
  assert.deepStrictEqual(Object.keys(r), ["MAC 2311", "MAC 2312", "BSC 2010"]);
  assert.strictEqual(r["BSC 2010"].length, 2);
  assert.ok(r["MAC 2312"][0].inProgress);
});

test("FIU audit: prerequisite status, attempts and must-finish-first", () => {
  const records = parseCourses("MAC 2311 (B), MAC 2312 (IP), COP 1047C (A), BSC 2010 (W), BSC 2010 (D)");
  const a = auditLayer(fiu, records, catalog);
  assert.strictEqual(group(a, "Prerequisites").status, "complete once current courses pass");
  assert.ok(a.warnings.some((w) => w.startsWith("BSC 2010") && /limit is 2/.test(w)));
  assert.ok(!a.warnings.some((w) => w.startsWith("MAC 2311")));
});

test("a D does not satisfy a C-or-higher requirement", () => {
  const a = auditLayer(aa, parseCourses("ENC 1101 (D)"), catalog);
  assert.strictEqual(group(a, "Communications").status, "incomplete");
});

test("AA: one course never fills two slots, and civic literacy needs the exam", () => {
  const a = auditLayer(aa, parseCourses("AMH 2020, MAC 2311, MAC 2312"), catalog);
  assert.strictEqual(group(a, "Mathematics").status, "complete");
  assert.strictEqual(group(a, "Civic Literacy").status, "incomplete");
  const b = auditLayer(aa, parseCourses("AMH 2020, FCLE"), catalog);
  assert.strictEqual(group(b, "Civic Literacy").status, "complete");
});
