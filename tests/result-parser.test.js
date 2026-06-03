const fs = require('fs');
const path = require('path');
const { extractPdfText, buildResultObject } = require('../services/resultParser');

async function runTests() {
  console.log("=== STARTING ISOLATED PARSER TESTS ===");
  const debugDir = path.join(__dirname, '..', 'debug');
  
  if (!fs.existsSync(debugDir)) {
      console.error("Debug directory not found!");
      return;
  }

  const files = fs.readdirSync(debugDir).filter(f => f.endsWith('.pdf'));
  
  for (const file of files) {
      console.log(`\n--- Testing ${file} ---`);
      try {
          const filePath = path.join(debugDir, file);
          const buffer = fs.readFileSync(filePath);
          
          console.log("[TEXT EXTRACTED] Starting...");
          const text = await extractPdfText(buffer);
          
          if (!text) {
              console.log("[FAIL] Extracted text is empty");
              continue;
          }
          
          const result = buildResultObject(text, "Fallback");
          if (result) {
              console.log("[SEMESTER FOUND]", result.semester);
              console.log("[SGPA FOUND]", result.sgpa);
              console.log("[CGPA FOUND]", result.cgpa);
              console.log("[SUBJECTS FOUND]", result.subjects.length);
              console.log("[RESULT PUSHED] Valid object created!");
              console.log(JSON.stringify(result, null, 2));
          } else {
              console.log("[FAIL] buildResultObject returned null");
          }
      } catch (err) {
          console.error(`[ERROR] Failed processing ${file}:`, err);
      }
  }
  console.log("\n=== ALL TESTS COMPLETED ===");
}

runTests();
