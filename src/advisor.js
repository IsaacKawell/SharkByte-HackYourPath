// The advisor: degree audit (plain code) + Swarms agent that explains the results.
const fs = require("fs");
const path = require("path");
const { parseCourses, auditLayer } = require("./audit");
const { callSwarms } = require("./swarms");
const { HttpError } = require("./errors");

// ---------- Requirement data (edit the JSON in /data, not this code) ----------
const readJSON = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", ...p), "utf8"));
const CATALOG = readJSON("courses.json").courses;
const AA = readJSON("aa.json");
const TRANSFER = {};
for (const f of fs.readdirSync(path.join(__dirname, "..", "data", "transfer"))) {
  if (!f.endsWith(".json")) continue;
  const t = readJSON("transfer", f);
  TRANSFER[t.id] = t;
}

const SYSTEM_PROMPT =
  "You are an academic pathway advisor for Miami Dade College (MDC) students. " +
  "Help students finish their Associate in Arts (AA) and prepare to transfer. Be clear, friendly, and concise. " +
  "RULES: Use ONLY the requirement notes and audit results provided in the task. " +
  "Never invent course codes, prerequisites, requirements, or deadlines. " +
  "The audit results are computed by software and are correct: explain them, do not recalculate them. " +
  "The AA audit and the transfer-school audit are separate: one course can count toward both. " +
  "Grade thresholds differ: AA general education needs C or higher, and each transfer school sets its own minimum. " +
  "An empty student course list is valid: recommend a balanced starting pathway based on the audit. " +
  "Recommend a balanced mix of eligible mathematics, writing, programming and general education when supported by the data. " +
  "Never recommend courses already completed or in progress. " +
  "Respect prerequisites and identify missing placement information instead of assuming eligibility. " +
  "Do not treat a single missing transfer prerequisite as the student's entire semester plan. " +
  "If a STUDENT COURSE LIST or audit results are present, the student HAS shared their courses: use them and never ask for them again. " +
  "If the task lists text we could not read as course codes, ask the student to use codes like MAC 2311. " +
  "If the student plans to continue at MDC, focus on finishing the AA and do not invent other MDC program requirements. " +
  "If something is not covered by the data, say so and recommend confirming with an MDC advisor or the transfer school.";

// Prompts for the planner page's two AI panels. They live here, on the server,
// so the browser cannot swap in its own instructions.
const MODES = {
  advisor: {
    agentName: "SharkByte Advisor",
    description: "Community-college transfer planning advisor",
    maxTokens: 1200,
    temperature: 0.4,
    systemPrompt:
      "You are a friendly academic advisor helping a Miami Dade College student plan a transfer to a university for a B.S. in Computer Science. " +
      "Use the student's plan data. Be concise, practical and specific. " +
      "Note that course requirements for non-FIU schools are estimates and should be confirmed with an advisor.",
  },
  mascot: {
    agentName: "Nom Nom",
    description: "Friendly shark assistant for MDC transfer planning",
    maxTokens: 600,
    temperature: 0.5,
    systemPrompt:
      "You are Nom Nom, a friendly, playful shark-mascot assistant (you may sprinkle in a light shark pun now and then) " +
      "helping a Miami Dade College student plan a transfer for a B.S. in Computer Science. " +
      "Keep answers short (under 120 words), practical and encouraging. " +
      "Course requirements for non-FIU schools are estimates; suggest confirming with an advisor.",
  },
};

// ---------- Input checks ----------
function text(value, name, max, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new HttpError(400, `"${name}" is required`);
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, `"${name}" must be text`);
  if (value.length > max) throw new HttpError(400, `"${name}" is too long (max ${max} characters)`);
  return value;
}

function cleanHistory(history, limit) {
  if (history == null) return [];
  if (!Array.isArray(history)) throw new HttpError(400, '"history" must be a list');
  return history.slice(-limit).map((m) => ({
    role: m && m.role === "user" ? "user" : "assistant",
    content: String((m && m.content) ?? "").slice(0, 2000),
  }));
}

const transcriptOf = (history) =>
  history.map((m) => `${m.role === "user" ? "Student" : "Advisor"}: ${m.content}`).join("\n");

// ---------- Public API ----------
function listTargets() {
  return Object.values(TRANSFER)
    .sort((a, b) => Number(!!b.noAudit) - Number(!!a.noAudit))
    .map((t) => ({ id: t.id, label: t.label }));
}

// Audit chat: used by /advisor.html.
async function chat(body = {}) {
  const message = text(body.message, "message", 2000, { required: true });
  const coursesText = text(body.courses, "courses", 5000);
  const history = cleanHistory(body.history, 20);

  const target = body.target ? TRANSFER[body.target] : null;
  if (body.target && !target) throw new HttpError(400, "Unknown transfer program");

  // Work out which entries are real course codes, so the student (and the agent)
  // can see what we actually understood.
  const PSEUDO = new Set(["FCLE", "CC TEST", "FLC EXAM"]);
  const allRecords = parseCourses(coursesText);
  const unrecognized = Object.keys(allRecords).filter(
    (c) => !/^[A-Z]{3} \d{4}[A-Z]?$/.test(c) && !PSEUDO.has(c)
  );
  const records = Object.fromEntries(Object.entries(allRecords).filter(([c]) => !unrecognized.includes(c)));
  const recognized = Object.keys(records);

  let auditBlock = "";
  {
    const audits = {
      associateInArts: auditLayer(AA, records, CATALOG),
      transferProgram: !target
        ? "No transfer goal selected."
        : target.noAudit
          ? "Student plans to continue at MDC; there is no separate transfer audit."
          : auditLayer(target, records, CATALOG),
      note: recognized.length
        ? "Courses listed without a grade were assumed passed."
        : "No completed courses reported. This is a valid new-student profile.",
    };
    auditBlock =
      `STUDENT COURSE LIST (${recognized.length} recognized): ${recognized.join(", ")}\n` +
      "AUDIT RESULTS (computed by software):\n" + JSON.stringify(audits);
  }
  if (unrecognized.length) {
    if (!recognized.length) auditBlock += "\nNo valid course codes were recognized.";
    auditBlock += `\nTEXT WE COULD NOT READ AS COURSE CODES: ${unrecognized.join(", ")}`;
  }

  const notes =
    "REQUIREMENT NOTES\nAA (" + AA.effectiveTerm + "):\n- " + AA.notes.join("\n- ") +
    (target ? `\n${target.school} ${target.program} (source: ${target.source}):\n- ` + target.notes.join("\n- ") : "");

  const transcript = transcriptOf(history);
  const task =
    notes + "\n\n" + auditBlock + "\n\n" +
    "CONVERSATION:\n" + (transcript ? transcript + "\n" : "") +
    `Student: ${message}\nAdvisor:`;

  const reply = await callSwarms({
    agentName: "Pathway-Advisor",
    description: "Academic pathway advisor",
    systemPrompt: SYSTEM_PROMPT,
    task,
    maxTokens: 1500,
    temperature: 0.4,
  });
  return { reply, recognized, unrecognized };
}

// Planner page: the "Swarms AI Advisor" panel (mode "advisor") and the Nom Nom chat (mode "mascot").
async function ask(body = {}) {
  const mode = MODES[body.mode];
  if (!mode) throw new HttpError(400, 'Unknown mode (use "advisor" or "mascot")');
  const message = text(body.message, "message", 2000, { required: true });
  const context = text(body.context, "context", 6000);
  const history = cleanHistory(body.history, 8);

  const fiu = TRANSFER["fiu-cs"];
  const verified = fiu
    ? `\n\n--- Verified requirements: ${fiu.school} ${fiu.program} (${fiu.source}) ---\n- ` + fiu.notes.join("\n- ")
    : "";
  const transcript = transcriptOf(history);
  const task =
    (transcript ? "Conversation so far:\n" + transcript + "\n\n" : "") +
    "Student: " + message +
    (context ? "\n\n--- Student plan data ---\n" + context : "") + verified;

  const reply = await callSwarms({ ...mode, task });
  return { reply };
}


// Structured academic recommendations for Gemini Schedule Master.
async function generatePathway(body = {}) {
  const student = body.student || {};
  const completed = Array.isArray(student.completedCourses)
    ? student.completedCourses : [];
  const inProgress = Array.isArray(student.inProgressCourses)
    ? student.inProgressCourses : [];
  const targets = Array.isArray(student.targetUniversities)
    ? student.targetUniversities : [];

  const normalize = c => String(c).trim().toUpperCase()
    .replace(/^([A-Z]{3})\s*(\d)/, "$1 $2");

  const excluded = new Set([...completed, ...inProgress].map(normalize));

  const requirements = [
    ...AA.requirements,
    ...targets.flatMap(t => {
      const key = String(t).toLowerCase().includes("fiu")
        ? "fiu-cs"
        : String(t).toLowerCase().includes("fsu")
          ? "fsu-cs" : null;
      return key && TRANSFER[key]
        ? TRANSFER[key].requirements : [];
    })
  ];

  const availableCodes = new Set();

  function collect(value) {
    if (typeof value === "string") {
      const code = normalize(value);
      if (CATALOG[code] && !excluded.has(code)) {
        availableCodes.add(code);
      }
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === "object") {
      if (value.courses) collect(value.courses);
      if (value.slots) collect(value.slots);
      if (value.options) collect(value.options);
    }
  }

  requirements.forEach(collect);

  const catalog = [...availableCodes].map(code => ({
    code,
    name: CATALOG[code].name,
    prerequisites: CATALOG[code].prereqs || null
  }));

  const task = JSON.stringify({
    instruction: "Recommend a balanced academic pathway. Return ONLY a JSON object with a recommendedCourses array. Each item must contain code, reason, priority. Select only from candidateCourses. Never recommend completed or in-progress courses. Do not treat missing prerequisites as confirmed eligibility. Balance mathematics, programming, general education and sciences. Consider prerequisite sequencing. Do not invent course sections, times or availability. Return at most 8 recommended courses.",
    student,
    candidateCourses: catalog,
    requirements: requirements.map(r => ({
      group: r.group,
      type: r.type,
      pick: r.pick,
      courses: r.courses,
      slots: r.slots
    }))
  });

  const raw = process.env.MOCK_SWARMS === "true"
    ? JSON.stringify(require("../data/mock/swarms-pathway.json"))
    : await callSwarms({
    agentName: "Academic-Pathway-Planner",
    description: "Structured academic pathway recommendations",
    systemPrompt: "You are an academic planning agent. Return valid JSON only. Use only provided course codes and requirements.",
    task,
    maxTokens: 1800,
    temperature: 0.2
  });

  let parsed;
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    throw new HttpError(502, "Swarms did not return valid pathway JSON");
  }

  const allowed = new Set(catalog.map(c => c.code));
  const seen = new Set();

  const recommendedCourses = (Array.isArray(parsed.recommendedCourses)
    ? parsed.recommendedCourses : [])
    .filter(c => c && typeof c.code === "string")
    .map(c => ({
      code: normalize(c.code),
      reason: String(c.reason || "").slice(0, 300),
      priority: String(c.priority || "medium")
    }))
    .filter(c => {
      if (!allowed.has(c.code) || seen.has(c.code)) return false;
      seen.add(c.code);
      return true;
    })
    .slice(0, 8);

  return {
    student,
    recommendedCourses,
    schedulingStatus: "pending",
    note: "Course recommendations require prerequisite and advisor verification. Gemini must schedule only sections supplied by the frontend."
  };
}

module.exports = { chat, ask, listTargets, generatePathway };
