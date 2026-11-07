// Tiny dependency-free server (Node 18+). Serves /public and proxies chat
// requests to the Swarms API so the API key never reaches the browser.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { parseCourses, auditLayer } = require("./src/audit");

// Minimal .env loader
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n").forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch {}

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SWARMS_API_KEY;
const SWARMS_URL = "https://api.swarms.world/v1/agent/completions";

// ---------- Requirement data (all in /data, edit the JSON, not the code) ----------
const readJSON = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, "data", ...p), "utf8"));
const CATALOG = readJSON("courses.json").courses;
const AA = readJSON("aa.json");
const TRANSFER = {};
for (const f of fs.readdirSync(path.join(__dirname, "data", "transfer"))) {
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
  "If the student has not shared their courses, ask them to list the courses they have completed or are taking, " +
  "with grades if they know them (for example: ENC 1101 (A), MAC 2312 (IP)). " +
  "If something is not covered by the data, say so and recommend confirming with an MDC advisor or the transfer school.";

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Swarms returns the agent text under "outputs"; its shape can vary,
// so handle a string, an array, or an object defensively.
function extractReply(data) {
  const out = data.outputs ?? data.output ?? data;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    const last = out[out.length - 1];
    return typeof last === "string" ? last : last?.content || JSON.stringify(last);
  }
  return out?.content || JSON.stringify(out);
}

async function handleChat(req, res) {
  if (!API_KEY) return send(res, 500, { error: "SWARMS_API_KEY is not set in .env" });

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return send(res, 400, { error: "Invalid JSON" }); }

  const target = body.target ? TRANSFER[body.target] : null;
  if (body.target && !target) return send(res, 400, { error: "Unknown transfer program" });

  // Deterministic audits, only if the student has told us their courses.
  const records = parseCourses(body.courses);
  const hasCourses = Object.keys(records).length > 0;
  let auditBlock = "AUDIT RESULTS: none yet (the student has not listed their courses).";
  if (hasCourses) {
    const audits = {
      associateInArts: auditLayer(AA, records, CATALOG),
      transferProgram: target ? auditLayer(target, records, CATALOG) : "No transfer school selected.",
      note: "Courses listed without a grade were assumed passed.",
    };
    auditBlock = "AUDIT RESULTS (computed by software):\n" + JSON.stringify(audits);
  }

  const notes =
    "REQUIREMENT NOTES\nAA (" + AA.effectiveTerm + "):\n- " + AA.notes.join("\n- ") +
    (target ? `\n${target.school} ${target.program} (source: ${target.source}):\n- ` + target.notes.join("\n- ") : "");

  const transcript = (body.history || [])
    .map((m) => `${m.role === "user" ? "Student" : "Advisor"}: ${m.content}`)
    .join("\n");

  const task =
    notes + "\n\n" + auditBlock + "\n\n" +
    "CONVERSATION:\n" + (transcript ? transcript + "\n" : "") +
    `Student: ${body.message}\nAdvisor:`;

  try {
    const r = await fetch(SWARMS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        agent_config: {
          agent_name: "Pathway-Advisor",
          description: "Academic pathway advisor",
          system_prompt: SYSTEM_PROMPT,
          model_name: "gpt-4o-mini",
          max_loops: 1,
          max_tokens: 1500,
          temperature: 0.4,
        },
        task,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Swarms error:", r.status, data);
      return send(res, 502, { error: "Swarms API returned " + r.status });
    }
    console.log("Swarms response:", JSON.stringify(data).slice(0, 500));
    send(res, 200, { reply: extractReply(data) });
  } catch (err) {
    console.error(err);
    send(res, 502, { error: "Could not reach the Swarms API" });
  }
}

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "GET" && req.url === "/api/targets")
    return send(res, 200, Object.values(TRANSFER).map((t) => ({ id: t.id, label: t.label })));

  const file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const full = path.join(__dirname, "public", path.normalize(file));
  if (!full.startsWith(path.join(__dirname, "public"))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, content) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "text/plain" });
    res.end(content);
  });
}).listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
