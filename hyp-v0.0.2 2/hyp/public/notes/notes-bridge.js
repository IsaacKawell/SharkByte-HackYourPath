/*
 * Plan Notes: chat bridge.
 *
 * Adds an optional "+ Add to table" button under each Nom Nom chat message and
 * wires the "My Notes" launcher. It only *observes* the chat log; Nom Nom's own
 * code and look are untouched. If the chat markup changes, this file is the one
 * place to adjust.
 *
 *   PlanNotesBridge.init({ core, store, ui, chatLog, launcher });
 */
(function (root, factory) {
  root.PlanNotesBridge = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PENDING = "…";                 // text Nom Nom shows while a reply is loading
  const GREETING = /^Hi, I'm Nom Nom/; // the fixed opening line is not worth saving

  function init({ core, store, ui, chatLog, launcher, showLauncherWhen }) {
    // ---------- launcher ("My Notes (n)" in the top bar) ----------
    if (launcher) {
      const label = () => `My Notes (${store.count()})`;
      const sync = () => { launcher.textContent = label(); };
      launcher.addEventListener("click", () => ui.toggle());
      store.subscribe(sync);
      sync();
      if (showLauncherWhen) {
        // Show the launcher once onboarding is finished (same moment "Generate JSON" appears).
        const apply = () => { launcher.hidden = showLauncherWhen.hidden; };
        new MutationObserver(apply).observe(showLauncherWhen, { attributes: true, attributeFilter: ["hidden"] });
        apply();
      } else launcher.hidden = false;
    }

    if (!chatLog) return { destroy() {} };

    // ---------- chat message buttons ----------
    const savedAs = new WeakMap(); // bubble element -> note id
    let openedOnce = false;

    const textOf = (bubble) => (bubble.textContent || "").trim();
    const isSavable = (bubble) => {
      const t = textOf(bubble);
      return t && t !== PENDING && !GREETING.test(t);
    };

    // The question a reply answers = the student bubble right before it.
    function questionFor(bubble) {
      let prev = bubble.previousElementSibling;
      while (prev && !prev.classList.contains("bubble")) prev = prev.previousElementSibling;
      return prev && prev.classList.contains("me") ? textOf(prev) : "";
    }

    function save(bubble) {
      const isUser = bubble.classList.contains("me");
      const text = textOf(bubble);
      const result = store.add(isUser
        ? { body: text, source: "nomnom-user" }
        : { body: text, question: questionFor(bubble), source: "nomnom-reply" });
      if (!result.ok) {
        ui.announce(result.reason === "full"
          ? `Your table is full (${core.MAX_NOTES} notes). Delete a few to add more.`
          : "Nothing to add from that message.");
        return;
      }
      savedAs.set(bubble, result.note.id);
      ui.announce(`Added to your table. You have ${store.count()} note${store.count() === 1 ? "" : "s"}.`);
      if (!ui.isOpen() && !openedOnce) ui.open(); // first save: show the student where it went
      openedOnce = true;
      ui.flash(result.note.id);
    }

    function makeRow(bubble) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pn-add-btn";
      btn.addEventListener("click", () => { if (!btn.disabled) save(bubble); });
      const row = document.createElement("div");
      row.className = "pn-chat-actions " + (bubble.classList.contains("me") ? "me" : "bot");
      row.dataset.pnFor = "1";
      row.append(btn);
      return row;
    }

    function paint(row, bubble) {
      const btn = row.firstElementChild;
      const noteId = savedAs.get(bubble);
      const saved = noteId && store.has(noteId);
      // Only write when something changed: our own edits inside the chat log would
      // otherwise retrigger the observer below and loop forever.
      const text = saved ? "✓ In table" : "+ Add to table";
      if (btn.textContent !== text) btn.textContent = text;
      btn.disabled = !!saved;
      const aria = saved ? "This message is in your notes table" : "Add this message to your notes table";
      if (btn.getAttribute("aria-label") !== aria) btn.setAttribute("aria-label", aria);
      row.hidden = !isSavable(bubble);
    }

    // Keeps every bubble's button correct. Safe to run repeatedly (idempotent).
    function sync() {
      chatLog.querySelectorAll(".bubble").forEach((bubble) => {
        let row = bubble.nextElementSibling;
        if (!(row && row.dataset && row.dataset.pnFor)) {
          row = makeRow(bubble);
          bubble.after(row);
        }
        paint(row, bubble);
      });
    }

    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; sync(); });
    };

    // Replies arrive by rewriting a "…" bubble in place, so watch text changes too.
    const observer = new MutationObserver(schedule);
    observer.observe(chatLog, { childList: true, subtree: true, characterData: true });
    const unsubscribe = store.subscribe(schedule);
    sync();

    return { destroy() { observer.disconnect(); unsubscribe(); } };
  }

  return { init };
});
