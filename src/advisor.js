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
  "Only ask the student for their courses if the task says AUDIT RESULTS: none yet. " +
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

  let auditBlock = "AUDIT RESULTS: none yet (the student has not listed their courses).";
  if (recognized.length) {
    const audits = {
      associateInArts: auditLayer(AA, records, CATALOG),
      transferProgram: !target
        ? "No transfer goal selected."
        : target.noAudit
          ? "Student plans to continue at MDC; there is no separate transfer audit."
          : auditLayer(target, records, CATALOG),
      note: "Courses listed without a grade were assumed passed.",
    };
    auditBlock =
      `STUDENT COURSE LIST (${recognized.length} recognized): ${recognized.join(", ")}\n` +
      "AUDIT RESULTS (computed by software):\n" + JSON.stringify(audits);
  }
  if (unrecognized.length) {
    if (!recognized.length) auditBlock = "AUDIT RESULTS: none yet (the student's text could not be read as course codes).";
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

module.exports = { chat, ask, listTargets };
