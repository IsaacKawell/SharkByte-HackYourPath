
const { GoogleGenAI } = require("@google/genai");

const {
  generateValidSchedules,
  scoreSchedule,
  analyzeRejectedSchedules,
  getScheduleWarnings
} = require("./scheduler");

// Cache Gemini explanations for identical requests
const advisorCache = new Map();

// Generate and rank schedules
function processSchedules(studentData) {
  const courses = studentData.courses;

  // Generate schedules that satisfy hard constraints
  const validSchedules = generateValidSchedules(
    courses,
    studentData.constraints || {}
  );

  // Analyze rejected class combinations
  const rejectedCombinations =
    analyzeRejectedSchedules(courses);

  // Explain when the requested courses exceed
  // the student's semester credit limit.
  const constraintWarnings = [];

  const totalRequestedCredits = courses.reduce(
    (total, course) => total + Number(course.credits || 0),
    0
  );

  const maxCredits =
    studentData.constraints?.maxCreditsPerSemester;

  if (
    maxCredits != null &&
    totalRequestedCredits > Number(maxCredits)
  ) {
    constraintWarnings.push({
      type: "MAX_CREDITS",
      totalCredits: totalRequestedCredits,
      maximum: Number(maxCredits),
      message:
        `The requested courses require ${totalRequestedCredits} credits, ` +
        `but your semester limit is ${maxCredits}.`
    });
  }

  // Map course codes to course names
  const courseNames = Object.fromEntries(
    courses.map(course => [
      course.code,
      course.name
    ])
  );

  const preferences = {
    student: studentData.preferences || {}
  };

  // Rank schedules and attach warnings
  const rankedSchedules = validSchedules
    .map(schedule => ({
      score: scoreSchedule(schedule, preferences),

      sections: schedule.map(section => ({
        ...section,
        courseCode: section.course,
        courseName:
          courseNames[section.course] ||
          section.course
      })),

      warnings: getScheduleWarnings(schedule)
    }))
    .sort((a, b) => b.score - a.score);

  return {
    college: studentData.college,
    term: studentData.term,
    totalValidSchedules: rankedSchedules.length,
    recommendedSchedule:
      rankedSchedules.length > 0 ? 1 : null,

    schedules: rankedSchedules,
    rejectedCombinations,
    constraintWarnings,
    aiAdvisor: null
  };
}

// Explain a specific selected schedule
async function explainSchedule(
  studentData,
  selectedSchedule
) {
  if (
    !selectedSchedule ||
    !Array.isArray(selectedSchedule.sections)
  ) {
    throw new Error("Invalid selected schedule");
  }

  const cacheKey = JSON.stringify({
    college: studentData.college,
    term: studentData.term,
    preferences: studentData.preferences,
    schedule: selectedSchedule
  });

  if (advisorCache.has(cacheKey)) {
    return advisorCache.get(cacheKey);
  }

  // Initialize Gemini only when an AI explanation is requested
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });

  const response = await ai.models.generateContent({
    model: "gemini-3.5-flash-lite",

    contents: `
You are an AI College Schedule Advisor.

College: ${studentData.college}
Term: ${studentData.term}

Student preferences:
${JSON.stringify(studentData.preferences, null, 2)}

Selected schedule:
${JSON.stringify(selectedSchedule, null, 2)}

Your tasks:
1. Explain the advantages of THIS selected schedule.
2. Identify preferences that are not satisfied.
3. Explain relevant campus and time considerations.
4. Be concise, clear, and helpful to a college student.

Important:
- Analyze ONLY the selected schedule.
- Never invent courses or sections.
- Do not modify the schedule or its score.
- Do not claim this is the best schedule unless verified.
- Distinguish preference mismatches from time conflicts.
- Confirmed time overlaps have been checked.
- Campus travel was checked where campus
  information was available.
- Missing campus or laboratory information
  must not be invented.
- Respect the schedule warnings provided.
- Return only the requested JSON structure.
`,

    config: {
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string"
          },
          warnings: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },
        required: ["summary", "warnings"]
      }
    }
  });

  const explanation = JSON.parse(response.text);

  advisorCache.set(cacheKey, explanation);

  return explanation;
}

module.exports = {
  processSchedules,
  explainSchedule
};
