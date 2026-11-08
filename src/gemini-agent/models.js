
const { GoogleGenAI } = require("@google/genai");

process.loadEnvFile(".env");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function main() {
  try {
    console.log("Checking available Gemini models...");

    const models = await ai.models.list();

    for await (const model of models) {
      console.log(model.name);
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

main();
