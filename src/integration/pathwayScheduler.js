const { buildScheduleFromAdvisor } = require("../gemini-agent/scheduleBridge");
const { getCourseFromCatalog } = require("../gemini-agent/catalogAdapter");

function schedulePathway(pathway, options = {}) {
  const term = options.term || "spring";
  const availableCourses = [];
  const unavailableCourses = [];

  for (const recommendation of pathway.recommendedCourses || []) {
    const code = typeof recommendation === "string"
      ? recommendation
      : recommendation.code;

    if (typeof code !== "string" || !code.trim()) {
      unavailableCourses.push({
        code: null,
        reason: "Invalid course recommendation"
      });
      continue;
    }

    try {
      const course = getCourseFromCatalog(code, term);
      if (!course.sections.length) {
        throw new Error("No sections available");
      }
      availableCourses.push(course);
    } catch (error) {
      unavailableCourses.push({
        code,
        reason: error.message
      });
    }
  }

  if (!availableCourses.length) {
    return {
      status: "no_available_courses",
      unavailableCourses,
      schedule: null
    };
  }

  const schedule = buildScheduleFromAdvisor({
    college: pathway.student?.college || "Miami Dade College",
    term,
    courses: availableCourses,
    preferences: options.preferences || {},
    constraints: options.constraints || {}
  });

  return {
    status: "completed",
    scheduledCourses: availableCourses.map(c => c.code),
    unavailableCourses,
    schedule
  };
}

module.exports = { schedulePathway };
