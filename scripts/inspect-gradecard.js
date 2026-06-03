const fs = require('fs');
const path = require('path');
const { extractPdfText, buildResultObject } = require('../services/resultParser');

async function inspectGradecards() {
  console.log("=== INSPECT GRADECARDS SCRIPT ===\n");
  const debugDir = path.join(__dirname, '..', 'debug');
  const files = fs.readdirSync(debugDir).filter(f => f.match(/^gradecard-\d+\.pdf$/));

  const reports = [];

  for (const file of files) {
    console.log(`--- Processing ${file} ---`);
    const filePath = path.join(debugDir, file);
    const buffer = fs.readFileSync(filePath);
    
    let text = "";
    try {
      text = await extractPdfText(buffer);
    } catch (err) {
      console.error(`Failed to extract text for ${file}:`, err.message);
      continue;
    }

    if (!text) {
      console.error(`Text extraction returned empty for ${file}`);
      continue;
    }

    // Save raw text
    const baseName = path.basename(file, '.pdf');
    fs.writeFileSync(path.join(debugDir, `${baseName}-raw.txt`), text, 'utf8');

    console.log(`[FILE] ${file}`);
    console.log(`[TEXT LENGTH] ${text.length}`);
    console.log(`[PREVIEW]\n${text.substring(0, 3000)}\n[END PREVIEW]\n`);

    const result = buildResultObject(text, baseName.split('-')[1]);
    
    // Save parsed JSON
    fs.writeFileSync(path.join(debugDir, `${baseName}-parsed.json`), JSON.stringify(result || {}, null, 2), 'utf8');

    const hasSemester = !!(result && result.semester);
    const hasSgpa = !!(result && result.sgpa);
    const hasCgpa = !!(result && result.cgpa);
    const hasSubjects = !!(result && result.subjects && result.subjects.length > 0);

    let confidenceScore = 0;
    if (hasSemester) confidenceScore += 25;
    if (hasSgpa || hasCgpa) confidenceScore += 25;
    if (hasSubjects) confidenceScore += 50;

    // A provisional certificate might have 0 marks and 0 sgpa, give it special handling in confidence if needed.
    if (text.includes("PROVISIONAL CERTIFICATE") && !text.includes("SGPA")) {
       confidenceScore = 100; // Expected to have no subjects
    }

    const report = {
      file,
      textExtracted: true,
      semesterFound: hasSemester,
      sgpaFound: hasSgpa,
      cgpaFound: hasCgpa,
      subjectsFound: hasSubjects,
      subjectCount: hasSubjects ? result.subjects.length : 0,
      confidence: `${confidenceScore}%`
    };

    console.log("[DETECTED SGPA]", result ? result.sgpa : null);
    console.log("[DETECTED CGPA]", result ? result.cgpa : null);
    console.log("[DETECTED SEMESTER]", result ? result.semester : null);
    console.log("[SUBJECT COUNT]", result && result.subjects ? result.subjects.length : 0);

    reports.push(report);
  }

  console.log("\n=== PARSER CONFIDENCE REPORT ===");
  console.log(JSON.stringify(reports, null, 2));

  reports.forEach(r => {
    if (parseInt(r.confidence) < 70) {
      console.warn(`[WARNING] Low confidence for ${r.file}. Needs separate investigation.`);
    }
  });
}

inspectGradecards();
