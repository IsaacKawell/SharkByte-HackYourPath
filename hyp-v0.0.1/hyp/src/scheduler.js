// Schedule builder (Google Gemini). Gemini picks sections from the verified MDC
// catalog; plain code then re-checks its answer, so a made-up section or a
// work-hour clash can never slip through as "PASSED".
const fs = require("fs");
const path = require("path");
const { HttpError } = require("./errors");

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "schedules", "catalog.json"), "utf8"));
const MODEL = "gemini-2.5-flash";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const normId = (c) => String(c || "").toUpperCase().replace(/\s+/g, "");

// "Monday Wednesday 9:50AM to 11:30AM" -> { days: [...], start: minutes, end: minutes } (or null times if TBA)
function parseMeeting(text = "") {
  const days = DAYS.filter((d) => text.includes(d));
  const m = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*to\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return { days, start: null, end: null };
  const toMin = (h, min, ap) => ((Number(h) % 12) + (ap.toUpperCase() === "PM" ? 12 : 0)) * 60 + Number(min);
  return { days, start: toMin(m[1], m[2], m[3]), end: toMin(m[4], m[5], m[6]) };
}
const hhmm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };

function validateHardConstraints(selectedSections, constraints = {}) {
  const conflicts = [];
  const warnings = [];
  let totalCredits = 0;
  const maxCredits = constraints.maxCreditsPerSemester || 15;
  const blocks = constraints.unavailableWorkTimes || [];

  for (const sec of selectedSections) {
    const id = normId(sec.course_id || sec.courseCode);
    totalCredits += sec.credits || (CATALOG[id] && CATALOG[id].credits) || 3;
    const meet = parseMeeting(sec.days_and_times);
    const label = sec.class_section || sec.lecture_section || "section";

    for (const block of blocks) {
      const shared = (block.days || []).filter((d) => meet.days.includes(d));
      if (!shared.length) continue;
      if (meet.start == null) {
        warnings.push({ type: "TIME_NOT_PUBLISHED", course: sec.course_id, message: `${label} meets on ${shared.join("/")} but has no published time; check it against your work hours.` });
        continue;
      }
      const bs = block.startTime ? hhmm(block.startTime) : 0;
      const be = block.endTime ? hhmm(block.endTime) : 24 * 60;
      if (meet.start < be && meet.end > bs) {
        conflicts.push({ type: "WORK_HOURS_OVERLAP", course: sec.course_id, message: `Section ${label} (${sec.days_and_times}) overlaps restricted work hours on ${shared.join("/")}.` });
      }
    }
  }
  if (totalCredits > maxCredits) {
    conflicts.push({ type: "CREDIT_LIMIT_EXCEEDED", totalCredits, maxAllowed: maxCredits, message: `Total credits (${totalCredits}) exceed maximum limit (${maxCredits}).` });
  }
  return { conflicts, warnings, totalCredits };
}

function poolFor(courses, term) {
  const pool = [];
  const missing = [];
  for (const code of courses) {
    const id = normId(code);
    const sections = (CATALOG[id] && CATALOG[id][term]) || [];
    if (sections.length) pool.push({ courseCode: id, sections });
    else missing.push({ type: "NO_SECTIONS_IN_CATALOG", course: code, message: `No ${term} sections for ${code} in the verified catalog.` });
  }
  return { pool, missing };
}

async function geminiJSON(prompt, schema) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(503, "The scheduler is not configured: set GEMINI_API_KEY on the server.");
  let GoogleGenAI;
  try { ({ GoogleGenAI } = await import("@google/genai")); }
  catch { throw new HttpError(503, "The scheduler needs the @google/genai package: run npm install."); }
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json", ...(schema ? { responseSchema: schema } : {}), temperature: 0.2 },
    });
    return JSON.parse(response.text);
  } catch (err) {
    console.error("Gemini error:", err.message);
    throw new HttpError(502, "The scheduling AI failed to answer. Try again.");
  }
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    semesterPlans: { type: "ARRAY", items: { type: "OBJECT" } },
    selectedSections: { type: "ARRAY", items: { type: "OBJECT" } },
    totalCredits: { type: "NUMBER" },
    conflicts: { type: "ARRAY", items: { type: "OBJECT" } },
    warnings: { type: "ARRAY", items: { type: "OBJECT" } },
    alternatives: { type: "ARRAY", items: { type: "OBJECT" } },
    estimatedTransferReadiness: { type: "STRING" },
    explanations: { type: "ARRAY", items: { type: "STRING" } },
    validationStatus: { type: "STRING" },
  },
  required: ["semesterPlans", "selectedSections", "totalCredits", "validationStatus"],
};

// `generate` can be swapped out in tests so no network is needed.
async function generateSchedule(input = {}, { generate = geminiJSON } = {}) {
  const courses = input.transferAnalysis?.requiredMajorCourses;
  if (!Array.isArray(courses) || !courses.length) {
    throw new HttpError(400, '"transferAnalysis.requiredMajorCourses" must be a non-empty list');
  }
  const term = String(input.targetTerm || "spring").toLowerCase();
  const { pool, missing } = poolFor(courses, term);
  if (!pool.length) throw new HttpError(404, `No ${term} sections found for those courses in the verified catalog.`);

  const prompt = `
You are the AI Academic Scheduling & Pathway Optimization Engine for SharkByte.
Using ONLY the verified MDC course sections provided below, build an optimized schedule. Do NOT invent fake sections.

Student Profile: ${JSON.stringify(input.studentProfile)}
Transfer Target: ${JSON.stringify(input.transferAnalysis)}
Verified Course Sections Catalog: ${JSON.stringify(pool)}
Constraints: ${JSON.stringify(input.schedulingConstraints)}

Your task:
1. Select valid sections from the catalog matching student campus and time constraints.
2. Respect maximum credits per semester and sequencing.
3. Provide semester-by-semester breakdown, alternatives if sections fill up, and transfer readiness explanations.

Return your response strictly matching the required JSON schema structure.`;

  const result = await generate(prompt, SCHEMA);

  // ---- Re-check the model's answer in code ----
  const selected = Array.isArray(result.selectedSections) ? result.selectedSections : [];
  const known = new Set(pool.flatMap((p) => p.sections.map((s) => `${p.courseCode}|${s.class_section}`)));
  const invented = selected.filter((s) => !known.has(`${normId(s.course_id)}|${s.class_section}`));
  const check = validateHardConstraints(selected, input.schedulingConstraints);
  const conflicts = [
    ...check.conflicts,
    ...invented.map((s) => ({ type: "SECTION_NOT_IN_CATALOG", course: s.course_id, message: `${s.course_id} ${s.class_section} is not in the verified catalog.` })),
  ];
  return {
    ...result,
    totalCredits: check.totalCredits,
    conflicts,
    warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), ...check.warnings, ...missing],
    validationStatus: conflicts.length ? "FAILED" : "PASSED",
    validatedBy: "server",
  };
}

async function replanSchedule(input = {}, changedConstraint, { generate = geminiJSON } = {}) {
  if (typeof changedConstraint !== "string" || !changedConstraint.trim()) {
    throw new HttpError(400, '"change" must be a non-empty string');
  }
  if (changedConstraint.length > 500) throw new HttpError(400, '"change" is too long');
  const prompt = `
You are the SharkByte What-if Simulator engine.
A student made a change or encountered a bottleneck: "${changedConstraint}"

Original Input Data:
${JSON.stringify(input)}

Recalculate the schedule using the verified course datasets, update semester plans, and explain transfer impact.
Return strictly JSON.`;
  return generate(prompt);
}

module.exports = { generateSchedule, replanSchedule, validateHardConstraints, parseMeeting };
