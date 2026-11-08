/*
 * Plan Notes: the interactive table (DOM only, no inline HTML from user text).
 *
 *   const ui = PlanNotesUI.mount({ root, store, core, onOpenChange });
 *   ui.open(); ui.close(); ui.toggle(); ui.flash(noteId); ui.announce("text");
 *
 * Every piece of student or AI text is written with textContent, never innerHTML,
 * so chat replies cannot inject markup into the page.
 */
(function (root, factory) {
  root.PlanNotesUI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  let uidCounter = 0;

  // Tiny DOM builder: h("button", { class: "x", onclick: fn }, "text", childNode)
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const COLUMNS = [
    { key: "done", label: "Done", sortable: true, cls: "pn-col-done" },
    { key: "title", label: "Topic", sortable: true, cls: "pn-col-title" },
    { key: "body", label: "Note", sortable: false, cls: "pn-col-body" },
    { key: "category", label: "Category", sortable: true, cls: "pn-col-cat" },
    { key: "school", label: "School", sortable: true, cls: "pn-col-school" },
    { key: "createdAt", label: "Added", sortable: true, cls: "pn-col-date" },
    { key: "actions", label: "Actions", sortable: false, cls: "pn-col-actions" },
  ];

  function mount({ root, store, core, onOpenChange = () => {} }) {
    const id = ++uidCounter;
    const titleId = "pn-title-" + id;
    const view = { query: "", category: "", school: "", hideDone: false, sortKey: "createdAt", sortDir: "desc" };
    let editingId = null;     // row currently being edited
    let renderQueued = false;
    let lastRemoved = null;   // for Undo
    let toastTimer = null;
    let returnFocusTo = null;
    let flashId = null;

    // ---------- static skeleton ----------
    const status = h("div", { class: "pn-status", role: "status", "aria-live": "polite" });
    const toastText = h("span", { class: "pn-toast-text" });
    const undoBtn = h("button", { type: "button", class: "pn-btn pn-btn-small", text: "Undo", onclick: undo });
    const toast = h("div", { class: "pn-toast", hidden: true }, toastText, undoBtn);

    const searchInput = h("input", {
      type: "search", class: "pn-input", placeholder: "Search notes…", "aria-label": "Search notes", maxlength: "100",
      oninput: (e) => { view.query = e.target.value; scheduleRender(); },
    });
    const catFilter = h("select", { class: "pn-input", "aria-label": "Filter by category", onchange: (e) => { view.category = e.target.value; scheduleRender(); } },
      h("option", { value: "", text: "All categories" }), core.CATEGORIES.map((c) => h("option", { value: c, text: c })));
    const schoolFilter = h("select", { class: "pn-input", "aria-label": "Filter by school", onchange: (e) => { view.school = e.target.value; scheduleRender(); } },
      h("option", { value: "", text: "All schools" }), core.SCHOOLS.filter(Boolean).map((s) => h("option", { value: s, text: s })));
    const hideDone = h("input", { type: "checkbox", onchange: (e) => { view.hideDone = e.target.checked; scheduleRender(); } });

    const clearDoneBtn = h("button", { type: "button", class: "pn-btn", text: "Clear done", onclick: clearDone });
    const exportBtn = h("button", { type: "button", class: "pn-btn", text: "Export CSV", title: "Download every note as a spreadsheet-friendly .csv file", onclick: exportCsv });
    const newBtn = h("button", { type: "button", class: "pn-btn pn-btn-primary", text: "+ New note", onclick: newNote });

    const count = h("span", { class: "pn-count" });
    const closeBtn = h("button", { type: "button", class: "pn-close", "aria-label": "Close notes table", title: "Close (Esc)", text: "×", onclick: () => close() });
    const heading = h("h2", { class: "pn-heading", id: titleId, tabindex: "-1", text: "My Plan Notes" });

    const thead = h("thead", {}, h("tr", {}, COLUMNS.map(headerCell)));
    const tbody = h("tbody");
    const table = h("table", { class: "pn-table" }, thead, tbody);
    const scroller = h("div", { class: "pn-scroll", tabindex: "0", role: "region", "aria-label": "Notes table (scrollable)" }, table);
    const empty = h("div", { class: "pn-empty" });

    root.classList.add("pn-workspace");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-labelledby", titleId);
    root.hidden = true;
    root.append(
      h("div", { class: "pn-titlebar" }, heading, count, closeBtn),
      h("div", { class: "pn-toolbar" },
        searchInput, catFilter, schoolFilter,
        h("label", { class: "pn-check" }, hideDone, " Hide done"),
        h("span", { class: "pn-spacer" }),
        newBtn, exportBtn, clearDoneBtn),
      scroller, empty,
      h("div", { class: "pn-footer" }, status, toast)
    );

    function headerCell(col) {
      const th = h("th", { scope: "col", class: col.cls, "data-key": col.key });
      if (!col.sortable) { th.textContent = col.label; return th; }
      th.append(h("button", { type: "button", class: "pn-sort", onclick: () => sortBy(col.key) }, col.label, h("span", { class: "pn-arrow", "aria-hidden": "true" })));
      return th;
    }

    function sortBy(key) {
      if (view.sortKey === key) view.sortDir = view.sortDir === "asc" ? "desc" : "asc";
      else { view.sortKey = key; view.sortDir = key === "createdAt" || key === "done" ? "desc" : "asc"; }
      scheduleRender();
    }

    // ---------- rendering ----------
    function scheduleRender() {
      if (editingId) return; // never rebuild rows under an open editor; render runs when it closes
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => { renderQueued = false; render(); });
    }

    function render() {
      const all = store.list();
      const shown = core.sortNotes(core.filterNotes(all, view), { key: view.sortKey, dir: view.sortDir });

      count.textContent = all.length ? `${shown.length} of ${all.length}` : "";
      clearDoneBtn.disabled = !all.some((n) => n.done);
      exportBtn.disabled = !all.length;

      thead.querySelectorAll("th[data-key]").forEach((th) => {
        const active = th.dataset.key === view.sortKey;
        th.setAttribute("aria-sort", active ? (view.sortDir === "asc" ? "ascending" : "descending") : "none");
        const arrow = th.querySelector(".pn-arrow");
        if (arrow) arrow.textContent = active ? (view.sortDir === "asc" ? " ▲" : " ▼") : "";
      });

      tbody.replaceChildren(...shown.map(row));
      scroller.hidden = !shown.length;

      if (!all.length) {
        empty.hidden = false;
        empty.replaceChildren(
          h("p", { class: "pn-empty-title", text: "Nothing here yet." }),
          h("p", { text: "Chat with Nom Nom and press “+ Add to table” under any message to save it here. You can also add your own note." })
        );
      } else if (!shown.length) {
        empty.hidden = false;
        empty.replaceChildren(h("p", { class: "pn-empty-title", text: "No notes match your filters." }),
          h("button", { type: "button", class: "pn-btn", text: "Clear filters", onclick: resetFilters }));
      } else empty.hidden = true;

      if (store.error()) announce(store.error());

      if (flashId) {
        const tr = tbody.querySelector(`tr[data-id="${CSS.escape(flashId)}"]`);
        if (tr) { tr.classList.add("pn-flash"); tr.scrollIntoView({ block: "nearest" }); }
        flashId = null;
      }
      requestAnimationFrame(markClamped);
    }

    function markClamped() {
      tbody.querySelectorAll(".pn-body-text").forEach((el) => {
        const more = el.parentElement.querySelector(".pn-more");
        if (more) more.hidden = !(el.scrollHeight > el.clientHeight + 1) && !el.classList.contains("pn-expanded");
      });
    }

    function row(n) {
      return n.id === editingId ? editRow(n) : readRow(n);
    }

    function selectCell(options, value, label, onChange) {
      return h("select", { class: "pn-input pn-cell-select", "aria-label": label, onchange: (e) => onChange(e.target.value) },
        options.map((o) => h("option", { value: o, text: o || "—", selected: o === value })));
    }

    function readRow(n) {
      const date = new Date(n.createdAt);
      const bodyText = h("div", { class: "pn-body-text", text: n.body });
      const more = h("button", { type: "button", class: "pn-more", hidden: true, text: "Show more", "aria-expanded": "false",
        onclick: () => {
          const open = bodyText.classList.toggle("pn-expanded");
          more.textContent = open ? "Show less" : "Show more";
          more.setAttribute("aria-expanded", String(open));
        } });
      const showAsked = n.question && n.question !== n.title;
      return h("tr", { "data-id": n.id, class: n.done ? "pn-done" : "" },
        h("td", { class: "pn-col-done", "data-label": "Done" },
          h("input", { type: "checkbox", checked: n.done, "aria-label": `Mark done: ${n.title}`,
            onchange: (e) => store.update(n.id, { done: e.target.checked }) })),
        h("td", { class: "pn-col-title", "data-label": "Topic" },
          h("div", { class: "pn-title-text", text: n.title }),
          showAsked && h("div", { class: "pn-asked", title: n.question, text: "Asked: " + n.question })),
        h("td", { class: "pn-col-body", "data-label": "Note" }, bodyText, more),
        h("td", { class: "pn-col-cat", "data-label": "Category" },
          selectCell(core.CATEGORIES, n.category, `Category for ${n.title}`, (v) => store.update(n.id, { category: v }))),
        h("td", { class: "pn-col-school", "data-label": "School" },
          selectCell(core.SCHOOLS, n.school, `School for ${n.title}`, (v) => store.update(n.id, { school: v }))),
        h("td", { class: "pn-col-date", "data-label": "Added" },
          h("time", { datetime: n.createdAt, title: date.toLocaleString(), text: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) })),
        h("td", { class: "pn-col-actions", "data-label": "Actions" },
          h("button", { type: "button", class: "pn-btn pn-btn-small", text: "Edit", "aria-label": `Edit ${n.title}`, onclick: () => startEdit(n.id) }),
          h("button", { type: "button", class: "pn-btn pn-btn-small pn-btn-danger", text: "Delete", "aria-label": `Delete ${n.title}`, onclick: () => del(n.id) })));
    }

    function editRow(n) {
      const titleIn = h("input", { type: "text", class: "pn-input pn-edit-title", maxlength: String(core.LIMITS.title), value: n.title, "aria-label": "Topic" });
      const bodyIn = h("textarea", { class: "pn-input pn-edit-body", rows: "5", maxlength: String(core.LIMITS.body), "aria-label": "Note text" });
      bodyIn.value = n.body;
      const save = () => {
        const res = store.update(n.id, { title: titleIn.value, body: bodyIn.value });
        if (!res.ok) { announce("A note needs a topic or some text."); return; }
        stopEdit(n.id);
      };
      const keys = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); stopEdit(n.id); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      };
      titleIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } else keys(e); });
      bodyIn.addEventListener("keydown", keys);
      return h("tr", { "data-id": n.id, class: "pn-editing" },
        h("td", { class: "pn-col-done", "data-label": "Done" }),
        h("td", { class: "pn-col-title", "data-label": "Topic" }, titleIn),
        h("td", { class: "pn-col-body", "data-label": "Note" }, bodyIn,
          h("div", { class: "pn-hint", text: "Ctrl/⌘+Enter to save · Esc to cancel" })),
        h("td", { class: "pn-col-cat", "data-label": "Category" }, n.category),
        h("td", { class: "pn-col-school", "data-label": "School" }, n.school || "—"),
        h("td", { class: "pn-col-date", "data-label": "Added" }),
        h("td", { class: "pn-col-actions", "data-label": "Actions" },
          h("button", { type: "button", class: "pn-btn pn-btn-small pn-btn-primary", text: "Save", onclick: save }),
          h("button", { type: "button", class: "pn-btn pn-btn-small", text: "Cancel", onclick: () => stopEdit(n.id) })));
    }

    function startEdit(noteId) {
      editingId = noteId;
      renderNow();
      const el = tbody.querySelector(".pn-edit-title");
      if (el) { el.focus(); el.select(); }
    }
    function stopEdit(noteId) {
      editingId = null;
      renderNow();
      const btn = tbody.querySelector(`tr[data-id="${CSS.escape(noteId)}"] .pn-col-actions button`);
      if (btn) btn.focus();
    }
    function renderNow() { renderQueued = false; render(); }

    // ---------- actions ----------
    function newNote() {
      resetFilters(true);
      const r = store.add({ title: "New note", body: "", source: "manual", category: "General" });
      if (!r.ok) { announce(r.reason === "full" ? `You can keep up to ${core.MAX_NOTES} notes. Delete some to add more.` : "Could not add note."); return; }
      startEdit(r.note.id);
    }

    function del(noteId) {
      const removed = store.remove(noteId);
      if (removed.length) showToast(`Deleted “${removed[0].note.title.slice(0, 40)}”.`, removed);
    }
    function clearDone() {
      const ids = store.list().filter((n) => n.done).map((n) => n.id);
      if (!ids.length) return;
      const removed = store.remove(ids);
      showToast(`Cleared ${removed.length} done note${removed.length === 1 ? "" : "s"}.`, removed);
    }
    function showToast(text, removed) {
      lastRemoved = removed;
      toastText.textContent = text;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 8000);
    }
    function hideToast() { toast.hidden = true; lastRemoved = null; }
    function undo() {
      if (!lastRemoved) return;
      store.restore(lastRemoved);
      hideToast();
      announce("Restored.");
    }

    function exportCsv() {
      const csv = "\uFEFF" + core.toCSV(store.list()); // BOM so Excel reads UTF-8 correctly
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = h("a", { href: url, download: `plan-notes-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      announce("Exported to CSV.");
    }

    function resetFilters(silent) {
      view.query = ""; view.category = ""; view.school = ""; view.hideDone = false;
      searchInput.value = ""; catFilter.value = ""; schoolFilter.value = ""; hideDone.checked = false;
      if (silent !== true) scheduleRender();
    }

    function announce(text) {
      status.textContent = "";
      // Re-set on the next tick so screen readers announce repeated identical messages.
      setTimeout(() => { status.textContent = text; }, 30);
    }

    // ---------- open / close ----------
    function place() {
      const bar = document.querySelector(".namebar");
      const top = bar ? Math.round(bar.getBoundingClientRect().bottom) + 12 : 12;
      root.style.setProperty("--pn-top", Math.max(top, 12) + "px");
    }
    function isOpen() { return !root.hidden; }
    function open() {
      if (isOpen()) return;
      returnFocusTo = document.activeElement;
      place();
      root.hidden = false;
      document.documentElement.classList.add("pn-open");
      renderNow();
      heading.focus();
      onOpenChange(true);
    }
    function close() {
      if (!isOpen()) return;
      if (editingId) { editingId = null; }
      root.hidden = true;
      document.documentElement.classList.remove("pn-open");
      onOpenChange(false);
      if (returnFocusTo && document.contains(returnFocusTo) && returnFocusTo.focus) returnFocusTo.focus();
      returnFocusTo = null;
    }
    function toggle() { isOpen() ? close() : open(); }

    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !editingId) { e.stopPropagation(); close(); }
    });
    window.addEventListener("resize", () => { if (isOpen()) place(); });

    // The store is the single source of truth; the view just reflects it.
    store.subscribe(() => { if (isOpen()) scheduleRender(); });

    return {
      open, close, toggle, isOpen, announce,
      flash(noteId) { flashId = noteId; if (isOpen()) renderNow(); },
    };
  }

  return { mount };
});
