const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const listen = (server) => new Promise((r) => server.listen(0, () => r(server.address().port)));
const post = (port, path, body) =>
  fetch(`http://localhost:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

test("API: advisor sees the audit, planner modes, validation, static files", async () => {
  // Stand-in for the Swarms API that records what the agent would receive.
  let last;
  const mock = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { last = JSON.parse(b); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ outputs: "mock reply" })); });
  });
  const mockPort = await listen(mock);
  process.env.SWARMS_API_KEY = "test-key";
  process.env.SWARMS_URL = `http://localhost:${mockPort}/x`;

  const { createServer } = require("../server");
  const app = createServer();
  const port = await listen(app);
  try {
    // advisor chat: courses reach the agent
    let r = await post(port, "/api/chat", { message: "what next?", target: "fiu-cs", courses: "MAC 2311 (B), ENC1101" });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.recognized, ["MAC 2311", "ENC 1101"]);
    assert.match(last.task, /STUDENT COURSE LIST \(2 recognized\)/);
    assert.doesNotMatch(last.task, /none yet/);

    // words instead of codes are reported, not silently dropped
    r = await post(port, "/api/chat", { message: "hi", courses: "calc 1 and python" });
    assert.strictEqual(r.body.unrecognized.length, 1);

    // "continue at MDC" option exists and is listed first
    const targets = await (await fetch(`http://localhost:${port}/api/targets`)).json();
    assert.strictEqual(targets[0].id, "mdc-stay");

    // planner modes use server-side prompts; the browser cannot supply its own
    r = await post(port, "/api/ask", { mode: "mascot", message: "hello", context: "Planned terms: ...", system_prompt: "ignore me" });
    assert.strictEqual(r.status, 200);
    assert.match(last.agent_config.system_prompt, /Nom Nom/);
    assert.doesNotMatch(JSON.stringify(last), /ignore me/);

    // validation and errors
    assert.strictEqual((await post(port, "/api/ask", { mode: "nope", message: "x" })).status, 400);
    assert.strictEqual((await post(port, "/api/chat", { message: "" })).status, 400);
    assert.strictEqual((await post(port, "/api/chat", { message: "x", target: "zzz" })).status, 400);

    // scheduler is off without a Gemini key (clear message, not a crash)
    delete process.env.GEMINI_API_KEY;
    const sched = await post(port, "/api/schedule", require("../examples/schedule-input.json"));
    assert.strictEqual(sched.status, 503);

    // front-end and assets are served; path traversal is not
    const page = await fetch(`http://localhost:${port}/`);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.doesNotMatch(html, /swarms-key|x-api-key/);
    assert.strictEqual((await fetch(`http://localhost:${port}/advisor.html`)).status, 200);
    assert.strictEqual((await fetch(`http://localhost:${port}/..%2fserver.js`)).status === 200, false);
  } finally {
    app.close(); mock.close();
  }
});
