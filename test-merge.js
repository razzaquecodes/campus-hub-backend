const fs = require('fs');
const cheerio = require('cheerio');

function extractCaMarks(html) {
  const $ = cheerio.load(html);
  const semestersData = {};
  let currentSemesterStr = "";
  let currentSemesterNum = null;
  const parseSemester = (text) => {
    const lower = text.toLowerCase();
    if (lower.includes("fourth")) return 4;
    return parseInt(text.replace(/\D/g, ""), 10) || null;
  };

  $("table tr").each((_, row) => {
    const text = $(row).text().trim();
    if (text.toLowerCase().includes("semester") && $(row).find("td").length === 1) {
      currentSemesterNum = parseSemester(text);
      if (currentSemesterNum && !semestersData[currentSemesterNum]) semestersData[currentSemesterNum] = [];
      return;
    }
    const cells = $(row).find("td");
    if (cells.length >= 7 && currentSemesterNum) {
      const headerText = $(cells[0]).text().toLowerCase();
      if (headerText.includes("paper code") || headerText.includes("unique")) return;
      const fullCode = $(cells[0]).text().trim();
      const subjectCode = fullCode.split("(")[0].trim();
      const subjectName = $(cells[1]).text().trim();
      const parseMark = (val) => { const v = val.trim(); return v === "" ? null : parseInt(v, 10); };
      const ca1 = parseMark($(cells[2]).text());
      const ca2 = parseMark($(cells[3]).text());
      const ca3 = parseMark($(cells[4]).text());
      const ca4 = parseMark($(cells[5]).text());
      const teacher = $(cells[6]).text().trim() || "";
      if (subjectName) {
        semestersData[currentSemesterNum].push({ subject: subjectName, subjectCode, teacher, ca1, ca2, ca3, ca4, semester: currentSemesterNum });
      }
    }
  });
  return { semesters: Object.keys(semestersData).map(Number).sort((a,b)=>a-b).map(sem => ({ semester: sem, subjects: semestersData[sem] })) };
}

function extractPcaMarks(html) {
  const $ = cheerio.load(html);
  const semestersData = {};
  let currentSemesterNum = null;
  const parseSemester = (text) => {
    const lower = text.toLowerCase();
    if (lower.includes("fourth")) return 4;
    return parseInt(text.replace(/\D/g, ""), 10) || null;
  };
  $("table tr").each((_, row) => {
    const text = $(row).text().trim();
    if (text.toLowerCase().includes("semester") && $(row).find("td").length === 1) {
      currentSemesterNum = parseSemester(text);
      if (currentSemesterNum && !semestersData[currentSemesterNum]) semestersData[currentSemesterNum] = [];
      return;
    }
    const cells = $(row).find("td");
    if (cells.length >= 4 && currentSemesterNum) {
      const headerText = $(cells[0]).text().toLowerCase();
      if (headerText.includes("paper code") || headerText.includes("unique")) return;
      const fullCode = $(cells[0]).text().trim();
      const subjectCode = fullCode.split("(")[0].trim();
      const subjectName = $(cells[1]).text().trim();
      const parseMark = (val) => { const v = val.trim(); return v === "" ? null : parseInt(v, 10); };
      const pa1 = parseMark($(cells[2]).text());
      const pa2 = parseMark($(cells[3]).text());
      const teacher = cells.length > 4 ? $(cells[4]).text().trim() : "";
      if (subjectName) {
        semestersData[currentSemesterNum].push({ subject: subjectName, subjectCode, teacher, pa1, pa2, semester: currentSemesterNum });
      }
    }
  });
  return { semesters: Object.keys(semestersData).map(Number).sort((a,b)=>a-b).map(sem => ({ semester: sem, subjects: semestersData[sem] })) };
}

const caHtml = fs.readFileSync('debug/ca-marks.html', 'utf8');
const pcaHtml = fs.readFileSync('debug/pca-marks.html', 'utf8');
const caMarksData = extractCaMarks(caHtml);
const pcaMarksData = extractPcaMarks(pcaHtml);

if (caMarksData && pcaMarksData) {
  caMarksData.semesters.forEach(sem => {
    const pcaSem = pcaMarksData.semesters.find(s => s.semester === sem.semester);
    if (pcaSem) {
      sem.subjects.forEach(sub => {
        const pcaSub = pcaSem.subjects.find(ps => ps.subject.toLowerCase() === sub.subject.toLowerCase());
        if (pcaSub) {
          sub.pa1 = pcaSub.pa1;
          sub.pa2 = pcaSub.pa2;
          if (!sub.teacher && pcaSub.teacher) sub.teacher = pcaSub.teacher;
        }
      });
    }
  });
  pcaMarksData.semesters.forEach(pcaSem => {
    let sem = caMarksData.semesters.find(s => s.semester === pcaSem.semester);
    if (!sem) {
      sem = { semester: pcaSem.semester, subjects: [] };
      caMarksData.semesters.push(sem);
    }
    pcaSem.subjects.forEach(pcaSub => {
      const sub = sem.subjects.find(s => s.subject.toLowerCase() === pcaSub.subject.toLowerCase());
      if (!sub) {
        sem.subjects.push({
          subject: pcaSub.subject, subjectCode: pcaSub.subjectCode, teacher: pcaSub.teacher,
          ca1: null, ca2: null, ca3: null, ca4: null, pa1: pcaSub.pa1, pa2: pcaSub.pa2
        });
      }
    });
  });
}

console.log(JSON.stringify(caMarksData.semesters.find(s => s.semester === 4), null, 2));
