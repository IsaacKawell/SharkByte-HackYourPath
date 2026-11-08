
const { getCourseFromCatalog } = require("./catalogAdapter");
const { processSchedules } = require("./scheduleService");

function buildScheduleFromAdvisor(studentData) {
  if (!studentData || typeof studentData !== "object" || Array.isArray(studentData)) {
    throw new Error("Invalid student data.");
  }

  const {
    college,
    term,
    courses,
    recommendedCourses,
    preferences = {},
    constraints = {}
  } = studentData;

  let selectedCourses;

  // Production mode: use courses and sections sent by frontend
  if (Array.isArray(courses) && courses.length > 0) {
    selectedCourses = courses;
  }

  // Legacy/demo mode: use local catalog
  else if (
    Array.isArray(recommendedCourses) &&
    recommendedCourses.length > 0
  ) {
    selectedCourses = recommendedCourses.map(code => {
      const course = getCourseFromCatalog(code, term);

      if (!course || !course.sections?.length) {
        throw new Error(
          `No available catalog sections for ${code} in ${term}.`
        );
      }

      return course;
    });
  }

  else {
    throw new Error("No courses provided.");
  }

  // Validate courses before scheduling
  for (const course of selectedCourses) {
    if (
      !course ||
      typeof course.code !== "string" ||
      !Array.isArray(course.sections) ||
      course.sections.length === 0
    ) {
      throw new Error(
        `Invalid course or missing sections: ${course?.code || "unknown"}`
      );
    }
  }

  return processSchedules({
    college,
    term,
    courses: selectedCourses,
    preferences,
    constraints
  });
}

module.exports = {
  buildScheduleFromAdvisor
};
