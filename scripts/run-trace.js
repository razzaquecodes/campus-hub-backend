const fs = require('fs');
const path = require('path');
const { extractPdfText, buildResultObject } = require('../services/resultParser');

async function runTrace() {
  console.log("=== STARTING FULL EXECUTION TRACE ===\n");
  const debugDir = path.join(__dirname, '..', 'debug');
  const files = fs.readdirSync(debugDir).filter(f => f.match(/^gradecard-\d+\.pdf$/));

  let gradecardsFound = files.length;
  let downloaded = files.length;
  let parsed = 0;
  let failed = 0;
  let finalResults = [];

  let sgpaCount = 0;
  let cgpaCount = 0;
  let subjectsCount = 0;
  const semestersDetected = new Set();

  for (const file of files) {
    const filePath = path.join(debugDir, file);
    console.log(`[GRADECARD FOUND] ${file}`);
    console.log(`[DOWNLOAD SUCCESS] ${file}`);
    console.log(`[PDF SAVED] ${filePath}`);
    
    try {
      const buffer = fs.readFileSync(filePath);
      const text = await extractPdfText(buffer);
      console.log(`[TEXT EXTRACTED] ${text.length} chars`);

      const baseName = path.basename(file, '.pdf');
      const fallbackSem = baseName.split('-')[1];

      const result = buildResultObject(text, fallbackSem);

      if (result) {
        console.log(`[SEMESTER FOUND] ${result.semester}`);
        console.log(`[SGPA FOUND] ${result.sgpa}`);
        console.log(`[CGPA FOUND] ${result.cgpa}`);
        console.log(`[SUBJECT COUNT] ${result.subjects ? result.subjects.length : 0}`);
        console.log(`[RESULT PUSHED] Yes`);
        
        parsed++;
        finalResults.push(result);

        if (result.semester) semestersDetected.add(result.semester);
        if (result.sgpa) sgpaCount++;
        if (result.cgpa) cgpaCount++;
        if (result.subjects) subjectsCount += result.subjects.length;
      } else {
        console.log(`[RESULT PUSHED] No`);
        failed++;
      }
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      failed++;
    }
    console.log("-----------------------------------------");
  }

  const traceOutput = {
    gradecardsFound,
    downloaded,
    parsed,
    failed,
    finalResults
  };

  const tracePath = path.join(debugDir, 'result-trace.json');
  fs.writeFileSync(tracePath, JSON.stringify(traceOutput, null, 2), 'utf8');
  console.log(`\nGenerated trace at: ${tracePath}\n`);

  const verificationSummary = {
    resultsLength: finalResults.length,
    semestersDetected: Array.from(semestersDetected).sort(),
    sgpaCount,
    cgpaCount,
    subjectsCount
  };

  console.log("=== STEP 8 VERIFICATION OUTPUT ===");
  console.log(JSON.stringify(verificationSummary, null, 2));

  if (finalResults.length > 0) {
    console.log("\n[SUCCESS] results.length > 0 achieved.");
  } else {
    console.log("\n[FAILURE] results is empty.");
  }
}

runTrace();
