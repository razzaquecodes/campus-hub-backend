const fs = require("fs");
const { PDFParse } = require("pdf-parse");

async function runTest() {
  console.log("=== PDF FORENSIC DEBUGGING ===");
  try {
    const pdfPath = "debug/gradecard-1.pdf";
    console.log("[LOG] Loading PDF:", pdfPath);
    
    const diskBuffer = fs.readFileSync(pdfPath);
    console.log("[LOG] Buffer Size:", diskBuffer.length);
    console.log("[LOG] Buffer Magic Bytes:", diskBuffer.slice(0, 20).toString());
    
    // Cast to Uint8Array as required by pdf-parse v2.4.5 API
    const uint8Array = new Uint8Array(diskBuffer);
    console.log("[LOG] Instantiating PDFParse...");
    const parser = new PDFParse(uint8Array);
    
    console.log("[LOG] Extracting text...");
    const parsedData = await parser.getText();
    
    const text = parsedData.text;
    console.log("[LOG] Extracted Text Length:", text.length);
    
    fs.writeFileSync("debug/test-output.txt", text, "utf8");
    console.log("[LOG] Saved text to debug/test-output.txt");
    
    console.log("\n=== TEXT PREVIEW (First 2000 chars) ===");
    console.log(text.substring(0, 2000));
    console.log("=======================================\n");

    // Test parsing logic
    console.log("=== TESTING REGEX PARSING ===");
    const sgpaMatch = text.match(/SGPA[^:]*:\s*([0-9.]+)/i);
    const cgpaMatch = text.match(/CGPA[^:]*:\s*([0-9.]+)/i) || text.match(/DGPA[^:]*:\s*([0-9.]+)/i) || text.match(/YGPA[^:]*:\s*([0-9.]+)/i);
    const semMatch = text.match(/(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH)\s+SEMESTER/i);

    let semesterStr = null;
    if (semMatch) {
       const semWord = semMatch[1].toUpperCase();
       if (semWord === 'FIRST') semesterStr = '1';
       if (semWord === 'SECOND') semesterStr = '2';
       if (semWord === 'THIRD') semesterStr = '3';
       if (semWord === 'FOURTH') semesterStr = '4';
       if (semWord === 'FIFTH') semesterStr = '5';
       if (semWord === 'SIXTH') semesterStr = '6';
       if (semWord === 'SEVENTH') semesterStr = '7';
       if (semWord === 'EIGHTH') semesterStr = '8';
    }

    const sgpa = sgpaMatch ? sgpaMatch[1] : null;
    const cgpa = cgpaMatch ? cgpaMatch[1] : null;

    console.log("[PARSED] SGPA:", sgpa);
    console.log("[PARSED] CGPA:", cgpa);
    console.log("[PARSED] Semester:", semesterStr);

    const subjects = [];
    const lines = text.split('\n');
    const validGrades = ['O', 'E', 'A', 'B', 'C', 'D', 'F', 'I'];
    
    for (let line of lines) {
       line = line.trim();
       if (!line) continue;
       
       const parts = line.split(/\s+/);
       if (parts.length >= 5) {
           const gradeCandidate = parts[parts.length - 4];
           const pointsCandidate = parts[parts.length - 3];
           const creditCandidate = parts[parts.length - 2];
           
           if (validGrades.includes(gradeCandidate) && !isNaN(parseFloat(pointsCandidate)) && !isNaN(parseFloat(creditCandidate))) {
               subjects.push({
                   subjectCode: parts[0],
                   subjectName: parts.slice(1, parts.length - 4).join(' '),
                   grade: gradeCandidate,
                   credits: creditCandidate
               });
           }
       }
    }
    console.log("[PARSED] Subject Count:", subjects.length);
    console.log("[PARSED] Subjects Data:", JSON.stringify(subjects, null, 2));

  } catch (err) {
    console.error("[ERROR] Forensic test failed:", err);
  }
}

runTest();
