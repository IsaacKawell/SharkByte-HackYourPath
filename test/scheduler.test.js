const test = require("node:test");
const assert = require("node:assert");
const { generateSchedule, validateHardConstraints, parseMeeting } = require("../src/scheduler");
const catalog = require("../data/schedules/catalog.json");
const input = require("../examples/schedule-input.json");

const block = [{ days: ["Tuesday"], startTime: "08:00", endTime: "11:00" }];
const sections = catalog.MAC2312.spring;
const clash = sections.find((s) => { const m = parseMeeting(s.days_and_times); return m.days.includes("Tuesday") && m.start < 660 && m.end > 480; });
const fine = sections.find((s) => { const m = parseMeeting(s.days_and_times); return m.start != null && !(m.days.includes("Tuesday") && m.start < 660 && m.end > 480); });

test("meeting times are parsed", () => {
  assert.deepStrictEqual(parseMeeting("Monday Wednesday 9:50AM to 11:30AM"), { days: ["Monday", "Wednesday"], start: 590, end: 690 });
  assert.strictEqual(parseMeeting("To be announced").start, null);
});

test("only real time overlaps count as conflicts", () => {
  const bad = validateHardConstraints([clash], { unavailableWorkTimes: block });
  assert.strictEqual(bad.conflicts[0].type, "WORK_HOURS_OVERLAP");
  const ok = validateHardConstraints([fine], { unavailableWorkTimes: block });
  assert.strictEqual(ok.conflicts.length, 0);
});

test("credit limit is enforced", () => {
  const r = validateHardConstraints([fine, fine, fine, fine, fine], { maxCreditsPerSemester: 12 });
  assert.ok(r.conflicts.some((c) => c.type === "CREDIT_LIMIT_EXCEEDED"));
});

test("the server re-checks the model: invented sections and clashes cannot pass", async () => {
  const fake = async () => ({
    semesterPlans: [], totalCredits: 1, validationStatus: "PASSED",
    selectedSections: [clash, { course_id: "MAC 2312", class_section: "Lecture - 0000", days_and_times: "Friday 1:00PM to 2:00PM" }],
  });
  const out = await generateSchedule(input, { generate: fake });
  assert.strictEqual(out.validationStatus, "FAILED");
  const types = out.conflicts.map((c) => c.type);
  assert.ok(types.includes("WORK_HOURS_OVERLAP") && types.includes("SECTION_NOT_IN_CATALOG"));
});

test("a clean answer passes", async () => {
  const fake = async () => ({ semesterPlans: [], totalCredits: 0, validationStatus: "PASSED", selectedSections: [fine] });
  const out = await generateSchedule(input, { generate: fake });
  assert.strictEqual(out.validationStatus, "PASSED");
});

test("bad input is rejected", async () => {
  await assert.rejects(() => generateSchedule({}), /requiredMajorCourses/);
});
