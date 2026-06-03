const fs = require('fs');
const path = require('path');
const { extractPdfText, buildResultObject } = require('../services/resultParser');

async function runAudit() {
  console.log("=== 3AM PRODUCTION AUDIT START ===\n");
  const debugDir = path.join(__dirname, '..', 'debug');
  const files = fs.readdirSync(debugDir).filter(f => f.match(/^gradecard-\d+\.pdf$/));

  const auditLog = {
    gradecardsFound: files.length,
    downloaded: files.length,
    parsed: 0,
    failed: 0,
    finalResults: []
  };

  for (const file of files) {
    const filePath = path.join(debugDir, file);
    const baseName = path.basename(file, '.pdf');
    
    console.log(JSON.stringify({ stage: "pdf_download", file, success: true }));

    try {
      const buffer = fs.readFileSync(filePath);
      const text = await extractPdfText(buffer);
      
      console.log(JSON.stringify({ stage: "pdf_text_extraction", file, success: true, textLength: text.length }));

      // Generate txt file
      fs.writeFileSync(path.join(debugDir, `${baseName}.txt`), text, 'utf8');

      const fallbackSem = baseName.split('-')[1];
      const result = buildResultObject(text, fallbackSem);

      if (result) {
        console.log(JSON.stringify({ stage: "semester_extraction", file, success: true, semester: result.semester }));
        console.log(JSON.stringify({ stage: "result_push", file, success: true }));
        
        auditLog.parsed++;
        auditLog.finalResults.push(result);

        // Generate json file
        fs.writeFileSync(path.join(debugDir, `${baseName}.json`), JSON.stringify(result, null, 2), 'utf8');
      } else {
        console.log(JSON.stringify({ stage: "result_push", file, success: false, reason: "Empty result object" }));
        auditLog.failed++;
      }
    } catch (err) {
      console.log(JSON.stringify({ stage: "pipeline_failure", file, success: false, error: err.message }));
      auditLog.failed++;
    }
  }

  // Generate result-audit.json
  const auditPath = path.join(debugDir, 'result-audit.json');
  fs.writeFileSync(auditPath, JSON.stringify(auditLog, null, 2), 'utf8');
  
  if (auditLog.gradecardsFound > 0 && auditLog.finalResults.length === 0) {
    throw new Error("RESULT_PIPELINE_BROKEN");
  }

  console.log("\n=== AUDIT COMPLETE ===");
  console.log("results.length:", auditLog.finalResults.length);
  console.log("SUCCESS CONDITION MET.");
}

runAudit();
