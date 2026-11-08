
function convertSection(courseCode, section) {
  const days = [
    "Monday", "Tuesday", "Wednesday",
    "Thursday", "Friday", "Saturday", "Sunday"
  ];

 
  // Standard courses use days_and_times.
  // COP1047C uses lecture_days_and_times.
  const meeting =
    section.days_and_times ||
    section.lecture_days_and_times ||
    "";

  const matchedDays = days.filter(day =>
    new RegExp(`\\b${day}\\b`, "i").test(meeting)
  );

  const timeMatch = meeting.match(
    /(\d{1,2}:\d{2})(AM|PM)\s+to\s+(\d{1,2}:\d{2})(AM|PM)/i
  );

  function to24Hour(time, period) {
    let [hour, minute] = time.split(":").map(Number);

    if (period.toUpperCase() === "PM" && hour !== 12) {
      hour += 12;
    }

    if (period.toUpperCase() === "AM" && hour === 12) {
      hour = 0;
    }

    return (
      `${String(hour).padStart(2, "0")}:` +
      `${String(minute).padStart(2, "0")}`
    );
  }

  // Team convention: "To be announced" means Online.
  const room = section.room || "";

  const isOnline =
    /to be announced/i.test(room) ||
    /to be announced/i.test(meeting);

  // Determine campus without inventing missing information.
  const campus = isOnline
    ? "Online"
    : room
      ? room.split("-")[0].trim()
      : "Unknown";

  // Determine course modality.
  const modality = isOnline
    ? "Online"
    : room
      ? "In-Person"
      : "Unknown";

  return {
    id: `${courseCode}-${section.option}`,
    course: courseCode,

    days: matchedDays,

    start: timeMatch
      ? to24Hour(timeMatch[1], timeMatch[2])
      : null,

    end: timeMatch
      ? to24Hour(timeMatch[3], timeMatch[4])
      : null,

    campus,
    modality,

    
    instructor:
      section.instructor ||
      section.lecture_instructor ||
      "Unknown",

    originalSection:
      section.class_section ||
      section.lecture_section ||
      null,

    labSection: section.lab_section || null,
    labInstructor: section.lab_instructor || null,
    labScheduleKnown:
      !section.lab_section,


    session: section.session || null,
    status: section.status || null,
    meetingDates: section.meeting_dates || null
  };
}

// Load the MDC course catalog.
const catalog = require("./catalog.json");

// Retrieve and convert all sections for a course and term.
function getCourseFromCatalog(courseCode, term) {
  const code = courseCode.replace(/\s/g, "").toUpperCase();
  const selectedTerm = term.toLowerCase();

  const course = catalog[code];

  if (!course) {
    throw new Error(
      `Course ${code} not found in MDC catalog`
    );
  }

  if (!Array.isArray(course[selectedTerm])) {
    throw new Error(
      `Term ${selectedTerm} not available for ${code}`
    );
  }

  return {
    code,
    name: course.name,
    credits: course.credits,

    sections: course[selectedTerm].map(section =>
      convertSection(code, section)
    )
  };
}

module.exports = {
  convertSection,
  getCourseFromCatalog
};
