/*
 * Plan Notes: composition root. Builds the store, mounts the table, connects the chat.
 * Loaded last on the planner page. Safe to load where the elements do not exist.
 */
(function () {
  "use strict";
  const core = window.PlanNotesCore;
  const root = document.getElementById("notes-workspace");
  if (!core || !window.PlanNotesUI || !window.PlanNotesBridge || !root) return;

  const launcher = document.getElementById("notes-toggle-btn");
  const store = core.createStore(); // localStorage today; swap the adapter for a server one later

  const ui = window.PlanNotesUI.mount({
    root, store, core,
    onOpenChange(open) { if (launcher) launcher.setAttribute("aria-expanded", String(open)); },
  });

  window.PlanNotesBridge.init({
    core, store, ui,
    chatLog: document.getElementById("chat-log"),
    launcher,
    showLauncherWhen: document.getElementById("export-json-btn"),
  });

  // Handy for debugging in the console: PlanNotes.store.list()
  window.PlanNotes = { store, ui };
})();
