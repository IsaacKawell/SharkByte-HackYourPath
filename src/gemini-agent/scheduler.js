const TRAVEL_GRACE_MINUTES = 5;

// Estimated driving times in minutes.
// Not live traffic data.
const CAMPUS_TRAVEL_TIMES = {
  North: {
    Wolfson: 30
  },
  Wolfson: {
    North: 30
  }
};

const DEFAULT_TRAVEL_MINUTES = 30;

// Convert HH:MM into minutes
function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

// Calculate required travel time
function getTravelTime(campusA, campusB) {
  if (
    campusA === campusB ||
    campusA === "Online" ||
    campusB === "Online" ||
    campusA === "Unknown" ||
    campusB === "Unknown"
  ) {
    return 0;
  }

  const estimatedTravel =
    CAMPUS_TRAVEL_TIMES[campusA]?.[campusB] ??
    DEFAULT_TRAVEL_MINUTES;

  return estimatedTravel + TRAVEL_GRACE_MINUTES;
}

// Check whether two sections share a day
function shareDay(sectionA, sectionB) {
  return sectionA.days.some(day =>
    sectionB.days.includes(day)
  );
}

// Explain a conflict between two sections
function getConflictDetails(sectionA, sectionB) {
  const sharedDays = sectionA.days.filter(day =>
    sectionB.days.includes(day)
  );

  if (sharedDays.length === 0) {
    return null;
  }

  // Missing meeting times cannot produce
  // a confirmed time overlap.
  if (
    !sectionA.start ||
    !sectionA.end ||
    !sectionB.start ||
    !sectionB.end
  ) {
    return null;
  }

  const startA = toMinutes(sectionA.start);
  const endA = toMinutes(sectionA.end);
  const startB = toMinutes(sectionB.start);
  const endB = toMinutes(sectionB.end);

  const timeOverlap =
    startA < endB &&
    startB < endA;

  if (timeOverlap) {
    return {
      type: "TIME_OVERLAP",
      sections: [sectionA.id, sectionB.id],
      days: sharedDays,
      message:
        `${sectionA.id} and ${sectionB.id} have overlapping class times.`
    };
  }

  // Travel cannot be reliably checked
  // when campus information is missing.
  if (
    sectionA.campus === sectionB.campus ||
    sectionA.campus === "Online" ||
    sectionB.campus === "Online" ||
    sectionA.campus === "Unknown" ||
    sectionB.campus === "Unknown"
  ) {
    return null;
  }

  const requiredMinutes = getTravelTime(
    sectionA.campus,
    sectionB.campus
  );

  let availableMinutes;
  let fromCampus;
  let toCampus;

  if (endA <= startB) {
    availableMinutes = startB - endA;
    fromCampus = sectionA.campus;
    toCampus = sectionB.campus;
  } else {
    availableMinutes = startA - endB;
    fromCampus = sectionB.campus;
    toCampus = sectionA.campus;
  }

  if (availableMinutes < requiredMinutes) {
    return {
      type: "CAMPUS_TRAVEL",
      sections: [sectionA.id, sectionB.id],
      days: sharedDays,
      fromCampus,
      toCampus,
      availableMinutes,
      requiredMinutes,
      missingMinutes:
        requiredMinutes - availableMinutes,
      message:
        `Only ${availableMinutes} minutes are available ` +
        `to travel from ${fromCampus} to ${toCampus}. ` +
        `${requiredMinutes} minutes are required.`
    };
  }

  return null;
}

// Check whether two sections conflict
function hasConflict(sectionA, sectionB) {
  return getConflictDetails(sectionA, sectionB) !== null;
}

// Generate schedules without confirmed class conflicts
function generateSchedules(courses, index = 0, current = []) {
  if (index === courses.length) {
    return [current];
  }

  const results = [];

  for (const section of courses[index].sections) {
    const conflict = current.some(selected =>
      hasConflict(selected, section)
    );

    if (!conflict) {
      const schedules = generateSchedules(
        courses,
        index + 1,
        [...current, section]
      );

      results.push(...schedules);
    }
  }

  return results;
}

// Analyze rejected section combinations
function analyzeRejectedSchedules(courses) {
  const rejected = [];
  const seen = new Set();

  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      const courseA = courses[i];
      const courseB = courses[j];

      for (const sectionA of courseA.sections) {
        for (const sectionB of courseB.sections) {
          const conflict = getConflictDetails(
            sectionA,
            sectionB
          );

          if (!conflict) {
            continue;
          }

          const key = [
            sectionA.id,
            sectionB.id,
            conflict.type
          ].join("|");

          if (seen.has(key)) {
            continue;
          }

          seen.add(key);

          const alternative = courseB.sections.find(
            candidate =>
              candidate.id !== sectionB.id &&
              !hasConflict(sectionA, candidate)
          );

          rejected.push({
            courseA: courseA.code,
            courseB: courseB.code,
            ...conflict,
            suggestedAlternative: alternative
              ? {
                  course: courseB.code,
                  sectionId: alternative.id,
                  days: alternative.days,
                  start: alternative.start,
                  end: alternative.end,
                  campus: alternative.campus
                }
              : null
          });
        }
      }
    }
  }

  return rejected;
}

// Calculate schedule score
function scoreSchedule(schedule, preferences) {
  let score = 100;
  const student = preferences.student;

  for (const section of schedule) {

    // Only evaluate time preferences
    // when meeting times are available.
    if (section.start && section.end) {
      if (
        student.earliestStartTime &&
        toMinutes(section.start) <
        toMinutes(student.earliestStartTime)
      ) {
        score -= 15;
      }

      if (
        student.latestEndTime &&
        toMinutes(section.end) >
        toMinutes(student.latestEndTime)
      ) {
        score -= 15;
      }
    }

    // Do not penalize unknown campus information.
    // It will be reported separately as a warning.
    if (
      student.preferredCampus &&
      section.campus !== "Unknown" &&
      section.campus !== "Online" &&
      section.campus !== student.preferredCampus
    ) {
      score -= 10;
    }

    for (const day of section.days) {
      if ((student.avoidDays || []).includes(day)) {
        score -= 20;
      }
    }
  }

  return Math.max(0, score);
}

// Validate student hard constraints:
// maximum credits and unavailable work times.
function validateStudentConstraints(
  schedule,
  constraints = {},
  courseCredits = {}
) {
  const conflicts = [];

  // Count each course only once.
  const uniqueCourses = [
    ...new Set(schedule.map(section => section.course))
  ];

  const totalCredits = uniqueCourses.reduce(
    (total, code) =>
      total + (courseCredits[code] || 0),
    0
  );

  if (
    constraints.maxCreditsPerSemester != null &&
    totalCredits > constraints.maxCreditsPerSemester
  ) {
    conflicts.push({
      type: "MAX_CREDITS",
      totalCredits,
      maximum: constraints.maxCreditsPerSemester,
      message:
        `Schedule contains ${totalCredits} credits, ` +
        `but the maximum is ${constraints.maxCreditsPerSemester}.`
    });
  }

  // Check conflicts with the student's work schedule.
  const workTimes =
    constraints.unavailableWorkTimes || [];

  for (const section of schedule) {
    // Missing meeting times cannot produce
    // a confirmed work-time conflict.
    if (!section.start || !section.end) {
      continue;
    }

    for (const work of workTimes) {
      const sharedDays = section.days.filter(day =>
        (work.days || []).includes(day)
      );

      if (sharedDays.length === 0) {
        continue;
      }

      const overlaps =
        toMinutes(section.start) <
          toMinutes(work.endTime) &&
        toMinutes(work.startTime) <
          toMinutes(section.end);

      if (overlaps) {
        conflicts.push({
          type: "WORK_CONFLICT",
          section: section.id,
          days: sharedDays,
          message:
            `${section.id} overlaps with the student's ` +
            `unavailable work hours.`
        });
      }
    }
  }

  return {
    valid: conflicts.length === 0,
    totalCredits,
    conflicts
  };
}

// Generate schedules satisfying hard constraints
function generateValidSchedules(courses, constraints = {}) {
  const schedules = generateSchedules(courses);

  const courseCredits = Object.fromEntries(
    courses.map(course => [
      course.code,
      course.credits
    ])
  );

  return schedules.filter(schedule => {
    const validation = validateStudentConstraints(
      schedule,
      constraints,
      courseCredits
    );

    return validation.valid;
  });
}

// Detect missing or incomplete schedule information
function getScheduleWarnings(schedule) {
  const warnings = [];

  for (const section of schedule) {

    // Missing campus information
    if (section.campus === "Unknown") {
      warnings.push({
        type: "UNKNOWN_CAMPUS",
        section: section.id,
        message:
          `Campus or modality information is missing for ${section.id}.`
      });
    }

    // Missing meeting time
    if (
      section.modality !== "Online" &&
      (!section.start || !section.end)
    ) {
      warnings.push({
        type: "UNKNOWN_MEETING_TIME",
        section: section.id,
        message:
          `Meeting time is missing for ${section.id}.`
      });
    }

    // Laboratory without a confirmed schedule
    if (section.labScheduleKnown === false) {
      warnings.push({
        type: "LAB_SCHEDULE_UNKNOWN",
        section: section.id,
        labSection: section.labSection,
        message:
          `Laboratory meeting time is unavailable for ${section.id}.`
      });
    }
  }

  return warnings;
}

// Export scheduler functions
module.exports = {
  generateSchedules,
  generateValidSchedules,
  hasConflict,
  scoreSchedule,
  getTravelTime,
  getConflictDetails,
  analyzeRejectedSchedules,
  validateStudentConstraints,
  getScheduleWarnings
};