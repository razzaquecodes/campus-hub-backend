const { PDFParse } = require("pdf-parse");

/**
 * Extracts text from a raw PDF buffer using pdf-parse.
 * Requires Uint8Array casting for v2.4.5 compatibility.
 */
async function extractPdfText(diskBuffer) {
  try {
    const parser = new PDFParse({ data: diskBuffer, verbosity: 0 });
    const parsedData = await parser.getText();
    if (typeof parser.destroy === 'function') {
        await parser.destroy();
    }
    const pdfText = parsedData?.text || "";
    
    console.log("[PDF TEXT LENGTH]", pdfText.length);
    console.log("[PDF PREVIEW]", pdfText.slice(0, 500));
    
    return pdfText;
  } catch (err) {
    console.error("[PDF PARSE ERROR FULL]", err);
    throw err;
  }
}

function parseSemester(text) {
  const exactMatch = text.match(/(FIRST|SECOND|THIRD|FOURTH)\s+YEAR\s+(FIRST|SECOND)\s+SEMESTER/i);
  if (exactMatch) {
    const yearWord = exactMatch[1].toUpperCase();
    const semWord = exactMatch[2].toUpperCase();
    
    console.log("[EXAM TITLE]", exactMatch[0]);
    console.log("[YEAR DETECTED]", yearWord);
    console.log("[SEMESTER DETECTED]", semWord);

    let base = 0;
    if (yearWord === 'FIRST') base = 0;
    else if (yearWord === 'SECOND') base = 2;
    else if (yearWord === 'THIRD') base = 4;
    else if (yearWord === 'FOURTH') base = 6;

    let offset = 0;
    if (semWord === 'FIRST') offset = 1;
    else if (semWord === 'SECOND') offset = 2;

    const finalSem = (base + offset).toString();
    console.log("[FINAL SEMESTER NUMBER]", finalSem);
    return finalSem;
  }

  // Fallback if the explicit year/semester string is missing
  const fallbackMatch = text.match(/(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH)\s+SEMESTER/i);
  if (fallbackMatch) {
    const semWord = fallbackMatch[1].toUpperCase();
    const map = {
      'FIRST': '1', 'SECOND': '2', 'THIRD': '3', 'FOURTH': '4',
      'FIFTH': '5', 'SIXTH': '6', 'SEVENTH': '7', 'EIGHTH': '8'
    };
    return map[semWord] || null;
  }
  return null;
}

function parseSgpa(text) {
  const sgpaMatch = text.match(/SGPA[^\n:]*:\s*([0-9.]+|-)/i);
  if (sgpaMatch) {
      return sgpaMatch[1] === '-' ? null : sgpaMatch[1];
  }
  return null;
}

function parseCgpa(text) {
  const cgpaMatch = text.match(/CGPA[^\n:]*:\s*([0-9.]+|-)/i) || 
                    text.match(/DGPA[^\n:]*:\s*([0-9.]+|-)/i) || 
                    text.match(/YGPA[^\n:]*:\s*([0-9.]+|-)/i);
  if (cgpaMatch) {
      return cgpaMatch[1] === '-' ? null : cgpaMatch[1];
  }
  return null;
}

function parseSubjects(text) {
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
  return subjects;
}

function buildResultObject(text, fallbackSemester = null) {
  // Ignore provisional certificates if they don't have SGPA
  if (text.includes("PROVISIONAL CERTIFICATE") && !text.includes("SGPA")) {
      return null;
  }

  const semester = parseSemester(text) || fallbackSemester;
  const sgpa = parseSgpa(text);
  const cgpa = parseCgpa(text);
  const subjects = parseSubjects(text);

  // Return result if at least one meaningful field exists
  if (semester || sgpa || cgpa || subjects.length > 0) {
      return {
          semester,
          sgpa,
          cgpa,
          subjects
      };
  }
  return null;
}

module.exports = {
  extractPdfText,
  parseSemester,
  parseSgpa,
  parseCgpa,
  parseSubjects,
  buildResultObject
};
