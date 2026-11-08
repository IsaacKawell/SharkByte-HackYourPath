const form = document.getElementById("chat-form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const coursesEl = document.getElementById("courses");
const targetEl = document.getElementById("target");
const statusEl = document.getElementById("courses-status");
const messagesEl = document.getElementById("messages");

// The agent has no memory between calls, so we keep history here
// and send it along with every request.
const history = [];

function addMessage(text, cls) {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function showCourseStatus(data) {
  const ok = data.recognized || [];
  const bad = data.unrecognized || [];
  let text = ok.length ? `Read ${ok.length} course(s): ${ok.join(", ")}.` : "No courses read yet.";
  if (bad.length) text += ` Could not read: ${bad.join(", ")}. Use codes like MAC 2311.`;
  statusEl.textContent = text;
}

addMessage("Hi! Tell me what you want to study and I'll help you plan it.", "bot");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage(text, "user");
  input.value = "";
  sendBtn.disabled = true;
  const pending = addMessage("Thinking…", "bot pending");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history, target: targetEl.value, courses: coursesEl.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    pending.remove();
    addMessage(data.reply, "bot");
    showCourseStatus(data);
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: data.reply });
  } catch (err) {
    pending.remove();
    addMessage("Something went wrong: " + err.message, "error");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

// Fill the transfer-goal dropdown from the data files.
fetch("/api/targets")
  .then((r) => r.json())
  .then((targets) => {
    for (const t of targets) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label;
      targetEl.appendChild(opt);
    }
  })
  .catch(() => {});
