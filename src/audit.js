// Deterministic degree audit. The AI never decides what is missing; this does.
// A "layer" is a requirement file: the MDC AA (data/aa.json) or a transfer
// program (data/transfer/*.json). Layers are audited independently, because one
// course can count toward the AA and toward a transfer school at the same time.

const GRADE_POINTS = {
  "A": 4, "A-": 3.7, "B+": 3.3, "B": 3, "B-": 2.7, "C+": 2.3, "C": 2,
  "C-": 1.7, "D+": 1.3, "D": 1, "D-": 0.7, "F": 0,
};

function normalizeCode(raw) {
  const t = String(raw).toUpperCase().replace(/\s+/g, " ").trim();
  const m = t.match(/^([A-Z]{3})\s?(\d{4}[A-Z]?)$/);
  return m ? `${m[1]} ${m[2]}` : t;
}

// Accepts "ENC 1101 (A), MAC 2311 (IP), BSC 2010 (W), COP 1047C" (string or array).
// (IP) = in progress, (W) = withdrew, (A)-(F) = grade. No tag = assumed passed.
// Repeat a course to record a retake.
function parseCourses(input) {
  const parts = Array.isArray(input) ? input : String(input || "").split(/[,\n;]+/);
  const records = {};
  for (const raw of parts) {
    const text = String(raw).trim();
    if (!text) continue;
    const tag = (text.match(/\(([^)]*)\)/) || [, ""])[1].trim().toUpperCase();
    const code = normalizeCode(text.replace(/\(.*?\)/g, ""));
    if (!code) continue;
    const rec = { inProgress: false, withdrawn: false, grade: null };
    if (tag === "IP" || tag === "IN PROGRESS") rec.inProgress = true;
    else if (tag === "W") rec.withdrawn = true;
    else if (tag in GRADE_POINTS) rec.grade = tag;
    (records[code] ||= []).push(rec);
  }
  return records;
}

function standing(recs, minPoints) {
  if (!recs) return { state: "none", attempts: 0 };
  const done = recs.filter((r) => !r.inProgress);
  const attempts = done.length; // grades and withdrawals both count as attempts
  const passed = done.some((r) => !r.withdrawn && (r.grade === null || GRADE_POINTS[r.grade] >= minPoints));
  if (passed) return { state: "passed", attempts };
  if (recs.some((r) => r.inProgress)) return { state: "inProgress", attempts };
  return { state: "failed", attempts };
}

const bundleOf = (o) => (Array.isArray(o) ? o : [o]);

function expandSlots(req) {
  if (req.type === "all") return req.courses.map((c) => ({ label: c, options: [[c]] }));
  if (req.type === "pick")
    return Array.from({ length: req.pick }, () => ({ label: req.group, options: req.courses.map(bundleOf) }));
  if (req.type === "slots") return req.slots.map((s) => ({ label: s.label, options: s.options.map(bundleOf) }));
  return [];
}

function auditLayer(layer, records, catalog = {}) {
  const minPoints = GRADE_POINTS[layer.minGrade || "C"];
  const cache = {};
  const stand = (c) => (cache[c] ||= standing(records[c], minPoints));
  const label = (c) => (catalog[c] ? `${c} (${catalog[c].name})` : c);
  const fmtOption = (o) => o.map(label).join(" + ");
  const fmtOptions = (opts) =>
    opts.length <= 25 ? opts.map(fmtOption) : `any one of ${opts.length} approved courses (see the official list)`;

  // 1. Turn every requirement into slots, then assign the student's courses to slots.
  //    A course fills at most one slot within a layer. Narrow slots go first.
  const slots = [];
  layer.requirements.forEach((req, ri) =>
    expandSlots(req).forEach((s) => slots.push({ ...s, ri, order: slots.length }))
  );
  const used = new Set();
  const assign = (slot, ok, status) => {
    const isLab = (opt) => opt.length === 1 && /\d{4}L$/.test(opt[0]);
    const ordered = [...slot.options].sort((a, b) => isLab(a) - isLab(b));
    for (const opt of ordered) {
      if (opt.every((c) => !used.has(c) && ok(c))) {
        opt.forEach((c) => used.add(c));
        slot.assigned = opt;
        slot.status = status;
        return;
      }
    }
  };
  const narrowFirst = [...slots].sort((a, b) => a.options.length - b.options.length || a.order - b.order);
  narrowFirst.forEach((s) => assign(s, (c) => stand(c).state === "passed", "passed"));
  narrowFirst.filter((s) => !s.assigned)
    .forEach((s) => assign(s, (c) => ["passed", "inProgress"].includes(stand(c).state), "inProgress"));

  // 2. Per-requirement results.
  const requirements = [];
  layer.requirements.forEach((req, ri) => {
    if (req.type === "note") {
      requirements.push({ group: req.group, status: "advisor-guided", note: req.note });
      return;
    }
    if (req.type === "check") {
      const hit = req.anyOf.find((c) => stand(c).state === "passed");
      const missingExtra = (req.also || []).filter((c) => stand(c).state !== "passed");
      const missing = [];
      if (!hit) missing.push("one of: " + req.anyOf.map(label).join(", "));
      missingExtra.forEach((c) => missing.push(label(c)));
      requirements.push({
        group: req.group, strength: "required",
        status: missing.length ? "incomplete" : "complete",
        satisfiedBy: hit ? [hit] : [], missing, note: req.note,
      });
      return;
    }
    const mine = slots.filter((s) => s.ri === ri);
    const done = mine.filter((s) => s.status === "passed");
    const ip = mine.filter((s) => s.status === "inProgress");
    const open = mine.filter((s) => !s.assigned);
    const out = {
      group: req.group,
      strength: req.strength || "required",
      status: open.length ? "incomplete" : ip.length ? "complete once current courses pass" : "complete",
      satisfiedBy: done.map((s) => fmtOption(s.assigned)),
      inProgress: ip.map((s) => fmtOption(s.assigned)),
      stillNeeded: open.length,
    };
    if (open.length) {
      out.open = open.map((s) =>
        req.type === "all" ? label(s.label) : { slot: s.label, chooseFrom: fmtOptions(s.options) }
      );
      const retake = new Set();
      open.forEach((s) => s.options.flat().forEach((c) => stand(c).state === "failed" && retake.add(c)));
      if (retake.size) out.notPassedYet = [...retake].map((c) => `${c} (${stand(c).attempts} attempt(s), not passing)`);
    }
    if (req.note) out.note = req.note;
    requirements.push(out);
  });

  // 3. What can the student take next? Only for small option lists, and only
  //    where we have prerequisite data. Labs are taken alongside their lecture.
  const nextUp = new Map();
  const blocked = new Map();
  const unknownPrereqs = new Set();
  const specific = (s) => layer.school || layer.requirements[s.ri].type === "all";
  slots.filter((s) => !s.assigned && s.options.length <= 8 && specific(s)).forEach((s) =>
    s.options.flat().forEach((c) => {
      if (/\d{4}L$/.test(c) || ["passed", "inProgress"].includes(stand(c).state)) return;
      const prereqs = catalog[c] && catalog[c].prereqs;
      if (!prereqs) { unknownPrereqs.add(c); return; }
      const lacking = prereqs.filter((p) => stand(p).state !== "passed");
      if (!lacking.length) nextUp.set(c, { course: label(c), ready: "now" });
      else if (lacking.every((p) => stand(p).state === "inProgress"))
        nextUp.set(c, { course: label(c), ready: "after current courses finish" });
      else blocked.set(c, { course: label(c), waitingOn: lacking.filter((p) => stand(p).state !== "inProgress") });
    })
  );

  // 4. Warnings from the layer's rules (attempt limits, must-finish-first courses).
  const warnings = [];
  if (layer.maxAttempts) {
    new Set(slots.flatMap((s) => s.options.flat())).forEach((c) => {
      const st = stand(c);
      if (st.state === "passed" || st.state === "inProgress") return;
      if (st.attempts >= layer.maxAttempts)
        warnings.push(`${c}: ${st.attempts} attempts used and not passed; the limit is ${layer.maxAttempts} (withdrawals count).`);
      else if (st.attempts === layer.maxAttempts - 1 && st.attempts > 0)
        warnings.push(`${c}: only one attempt left (withdrawals count as attempts).`);
    });
  }
  (layer.mustCompleteBeforeTransfer || []).forEach((c) => {
    const st = stand(c).state;
    if (st === "inProgress") warnings.push(`${c} must be completed before transfer (currently in progress).`);
    else if (st !== "passed") warnings.push(`${c} must be completed before transfer.`);
  });

  return {
    layer: layer.name || `${layer.school}: ${layer.program}`,
    source: layer.source,
    minimumGradeToCount: layer.minGrade,
    rules: layer.rules || undefined,
    requirements,
    nextUp: [...nextUp.values()],
    blocked: [...blocked.values()],
    prereqsNotInOurData: [...unknownPrereqs],
    warnings,
    // For the AA this hints at pathway-elective candidates; meaningless for transfer layers.
    coursesNotUsedByThisLayer: layer.school
      ? undefined
      : Object.keys(records).filter((c) => !used.has(c) && !["FCLE", "CC TEST", "FLC EXAM"].includes(c)),
  };
}

module.exports = { parseCourses, auditLayer, normalizeCode };
