import { GoogleGenAI } from '@google/genai';
import { masterCatalog } from './course_catalog.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "AQ.Ab8RN6LdfHL1NlU7H0Ri41aRhQZijBSVo7MUSVNMgL_T32MFhA" });

function validateHardConstraints(selectedSections, studentProfile, schedulingConstraints) {
    let conflicts = [];
    let warnings = [];
    let totalCredits = 0;

    const maxCredits = schedulingConstraints.maxCreditsPerSemester || 15;
    const workBlocks = schedulingConstraints.unavailableWorkTimes || [];

    for (const sec of selectedSections) {
        totalCredits += sec.credits || 3;
        const daysText = sec.days_and_times || "";
        
        for (const block of workBlocks) {
            const blockDays = block.days || [];
            if (blockDays.some(day => daysText.includes(day))) {
                conflicts.push({
                    type: "POTENTIAL_SCHEDULE_OVERLAP",
                    course: sec.course_id,
                    message: `Section ${sec.class_section || sec.lecture_section} timing overlaps with restricted work hours.`
                });
            }
        }
    }

    if (totalCredits > maxCredits) {
        conflicts.push({
            type: "CREDIT_LIMIT_EXCEEDED",
            totalCredits: totalCredits,
            maxAllowed: maxCredits,
            message: `Total credits (${totalCredits}) exceed maximum limit (${maxCredits}).`
        });
    }

    return {
        validationStatus: conflicts.length > 0 ? "FAILED" : "PASSED",
        conflicts,
        warnings,
        totalCredits
    };
}

async function generateSchedule(inputData) {
    const targetCourses = inputData.transferAnalysis.requiredMajorCourses || [];
    const term = inputData.targetTerm?.toLowerCase() || 'spring';
    
    let availableSectionsPool = [];
    for (const code of targetCourses) {
        if (masterCatalog[code]) {
            const termData = masterCatalog[code][term] || [];
            availableSectionsPool.push({ courseCode: code, sections: termData });
        }
    }

    const { validationStatus, conflicts, warnings, totalCredits } = validateHardConstraints(
        [],
        inputData.studentProfile || {},
        inputData.schedulingConstraints || {}
    );

    const prompt = `
    You are the AI Academic Scheduling & Pathway Optimization Engine for SharkByte.
    Using ONLY the verified MDC course sections provided below, build an optimized schedule. Do NOT invent fake sections.

    Student Profile: ${JSON.stringify(inputData.studentProfile)}
    Transfer Target: ${JSON.stringify(inputData.transferAnalysis)}
    Verified Course Sections Catalog: ${JSON.stringify(availableSectionsPool)}
    Constraints: ${JSON.stringify(inputData.schedulingConstraints)}

    Your task:
    1. Select valid sections from the catalog matching student campus and time constraints.
    2. Respect maximum credits per semester and sequencing.
    3. Provide semester-by-semester breakdown, alternatives if sections fill up, and transfer readiness explanations.

    Return your response strictly matching the required JSON schema structure.
    `;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    semesterPlans: { type: "ARRAY", items: { type: "OBJECT" } },
                    selectedSections: { type: "ARRAY", items: { type: "OBJECT" } },
                    totalCredits: { type: "NUMBER" },
                    conflicts: { type: "ARRAY", items: { type: "OBJECT" } },
                    warnings: { type: "ARRAY", items: { type: "OBJECT" } },
                    alternatives: { type: "ARRAY", items: { type: "OBJECT" } },
                    estimatedTransferReadiness: { type: "STRING" },
                    explanations: { type: "ARRAY", items: { type: "STRING" } },
                    validationStatus: { type: "STRING" }
                },
                required: ["semesterPlans", "selectedSections", "totalCredits", "validationStatus"]
            },
            temperature: 0.2,
        }
    });

    return JSON.parse(response.text);
}

async function replanSchedule(inputData, changedConstraint) {
    const prompt = `
    You are the SharkByte What-if Simulator engine. 
    A student made a change or encountered a bottleneck: "${changedConstraint}"

    Original Input Data:
    ${JSON.stringify(inputData)}

    Recalculate the schedule using the verified course datasets, update semester plans, and explain transfer impact.
    Return strictly JSON.
    `;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            temperature: 0.2,
        }
    });

    return JSON.parse(response.text);
}

(async () => {
    const sampleInput = {
        studentProfile: {
            name: "Alex Rodriguez",
            homeCampus: "MDC North",
            targetUniversities: ["UF", "FSU", "FIU"],
            targetTransferTerm: "Fall 2027"
        },
        transferAnalysis: {
            requiredMajorCourses: ["MAC2312", "PHY2048", "COP1047C"],
            criticalPath: "PHY2048 and MAC2312 are mandatory for UF Engineering transfer."
        },
        targetTerm: "spring",
        schedulingConstraints: {
            maxCreditsPerSemester: 13,
            unavailableWorkTimes: [
                { days: ["Tuesday"], startTime: "08:00", endTime: "11:00" }
            ]
        }
    };

    console.log("--- Running SharkByte Engine with Compiled MDC Datasets ---");
    const result = await generateSchedule(sampleInput);
    console.log(JSON.stringify(result, null, 2));

    console.log("\n--- Running What-If Simulator ---");
    const whatIfResult = await replanSchedule(sampleInput, "What if all morning MAC2312 sections are full?");
    console.log(JSON.stringify(whatIfResult, null, 2));
})();