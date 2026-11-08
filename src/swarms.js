// The only place that talks to the Swarms API. The key is read from the
// environment on the server and never reaches the browser.
const { HttpError } = require("./errors");

// Swarms returns the agent text under "outputs"; its shape can vary,
// so handle a string, an array, or an object defensively.
function extractReply(data) {
  const out = data && (data.outputs ?? data.output ?? data.result ?? data.response ?? data);
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    const last = out[out.length - 1];
    return typeof last === "string" ? last : last?.content || JSON.stringify(last);
  }
  return out?.content || JSON.stringify(out);
}

async function callSwarms({ agentName, description, systemPrompt, task, maxTokens = 1500, temperature = 0.4 }) {
  const key = process.env.SWARMS_API_KEY;
  if (!key) throw new HttpError(500, "SWARMS_API_KEY is not set on the server (.env)");
  const url = process.env.SWARMS_URL || "https://api.swarms.world/v1/agent/completions";

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        agent_config: {
          agent_name: agentName,
          description,
          system_prompt: systemPrompt,
          model_name: "gpt-4o-mini",
          max_loops: 1,
          max_tokens: maxTokens,
          temperature,
        },
        task,
      }),
    });
  } catch (err) {
    console.error("Swarms request failed:", err.message);
    throw new HttpError(502, "Could not reach the Swarms API");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("Swarms error:", res.status, JSON.stringify(data).slice(0, 300));
    throw new HttpError(502, "Swarms API returned " + res.status);
  }
  return extractReply(data);
}

module.exports = { callSwarms, extractReply };
