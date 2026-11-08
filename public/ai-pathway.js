(() => {
  const button = document.getElementById("sb-ai-build");
  const output = document.getElementById("sb-ai-output");

  if (!button || !output) return;

  const get = (id) => document.getElementById(id)?.value || "";

  const codes = (value) =>
    value.split(/[,;\n]+/)
      .map(code => code.trim().toUpperCase())
      .filter(Boolean);

  const show = (message) => {
    output.textContent = message;
    output.style.whiteSpace = "pre-wrap";
  };

  button.addEventListener("click", async () => {
    const completedCourses = codes(get("sb-completed"));
    const major = get("sb-major");
    const term = get("sb-term");

    const targetUniversities =
      typeof UNIVERSITIES !== "undefined" &&
      typeof selectedUnis !== "undefined"
        ? UNIVERSITIES
            .filter(u => selectedUnis.has(u.id))
            .map(u => u.short)
        : [];

    if (!major || !term || !targetUniversities.length) {
      show("Please select a major, term, and target university.");
      return;
    }

    const payload = {
      student: {
        college: "Miami Dade College",
        major,
        targetUniversities,
        completedCourses,
        inProgressCourses: []
      },
      term,
      preferences: {},
      constraints: {}
    };

    button.disabled = true;
    show("Generating AI pathway and schedule...");

    try {
      const response = await fetch("/api/pathway/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "API request failed");
      }

      const recommendations =
        result.pathway?.recommendedCourses || [];

      const scheduling = result.scheduling || {};
      const scheduled = scheduling.scheduledCourses || [];
      const unavailable = scheduling.unavailableCourses || [];
      const total = scheduling.schedule?.totalValidSchedules || 0;

      const lines = [
        "AI PATHWAY & SCHEDULE",
        "",
        "Recommended Courses:",
        ...recommendations.map(c =>
          "- " + (typeof c === "string" ? c : c.code)
        ),
        "",
        "Scheduled Courses:",
        scheduled.join(", ") || "None",
        "",
        "Valid Schedule Combinations: " + total,
        "",
        "Unavailable Courses:",
        ...unavailable.map(c =>
          "- " + c.code + ": " + c.reason
        )
      ];

      show(lines.join("\n"));
    } catch (error) {
      show("Error: " + error.message);
    } finally {
      button.disabled = false;
    }
  });
})();
