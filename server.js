require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// ─── Supabase client (service role — bypasses RLS) ────────────────────────────
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SERVICE_ROLE_PRESENT:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Startup connectivity test ──────────────────────────────────────────────────
(async () => {
  const test = await supabase.from("students").select("*").limit(1);
  console.log("[SUPABASE TEST]", JSON.stringify(test, null, 2));
})();

const app = express();
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Campus Hub Backend Running" });
});

// ─── MAKAUT verification ──────────────────────────────────────────────────────
app.post("/verify-student", async (req, res) => {
  const { rollNumber, password } = req.body;

  if (!rollNumber || !password) {
    return res.status(400).json({
      verified: false,
      message: "rollNumber and password are required",
    });
  }

  // 1. Create a CookieJar and an axios client that automatically manages cookies
  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        // Emulate a real Chrome browser request
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    })
  );

  const BASE_URL = "https://makaut1.ucanapply.com/smartexam/public";

  try {
    // ── Step 1: Fetch the homepage to obtain CSRF token & session cookie ──────
    console.log("[MAKAUT] Fetching homepage to obtain CSRF token …");
    const homepageRes = await client.get(`${BASE_URL}/`);
    console.log(
      `[MAKAUT] Homepage fetched — status: ${homepageRes.status}, body length: ${homepageRes.data.length}`
    );

    // ── Step 2: Extract CSRF token (and any other hidden fields) ──────────────
    const $home = cheerio.load(homepageRes.data);

    let csrfToken =
      $home('meta[name="csrf-token"]').attr("content") ||
      $home('input[name="_token"]').val();

    if (!csrfToken) {
      console.error("[MAKAUT] CSRF token NOT found in homepage HTML");
      return res.status(502).json({
        verified: false,
        message: "Could not extract CSRF token from MAKAUT portal",
      });
    }
    console.log(`[MAKAUT] CSRF token extracted: ${csrfToken.substring(0, 20)}…`);

    // Collect any additional hidden inputs from the login form (if present)
    const hiddenFields = {};
    $home('form input[type="hidden"]').each((_, el) => {
      const name = $home(el).attr("name");
      const value = $home(el).val();
      if (name && name !== "_token") {
        hiddenFields[name] = value;
      }
    });
    if (Object.keys(hiddenFields).length > 0) {
      console.log("[MAKAUT] Additional hidden form fields found:", hiddenFields);
    }

    // ── Step 3: Build and submit login POST ───────────────────────────────────
    const loginUrl = `${BASE_URL}/checkLogin`;
    const formParams = new URLSearchParams();
    formParams.append("_token", csrfToken);
    formParams.append("typ", "5");
    formParams.append("username", rollNumber);
    formParams.append("password", password);

    for (const [k, v] of Object.entries(hiddenFields)) {
      formParams.append(k, v);
    }

    console.log(
      `[MAKAUT] Attempting login for roll number: ${rollNumber} → POST ${loginUrl}`
    );

    const loginRes = await client.post(loginUrl, formParams.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${BASE_URL}/`,
        Origin: "https://makaut1.ucanapply.com",
      },
      validateStatus: () => true,
    });

    console.log(
      `[MAKAUT] Login response — status: ${loginRes.status}, final URL: ${loginRes.request?.res?.responseUrl ?? "unknown"}, body length: ${loginRes.data.length}`
    );

    // ── Step 4: Determine login success ───────────────────────────────────────
    const responseBody =
      typeof loginRes.data === "string"
        ? loginRes.data
        : JSON.stringify(loginRes.data);
    const finalUrl = loginRes.request?.res?.responseUrl ?? "";



    const $login = cheerio.load(responseBody);

    const hasErrorAlert =
      $login(".alert-danger").length > 0 ||
      $login('[class*="error"]').length > 0 ||
      /invalid|incorrect|failed|unauthorized/i.test(responseBody);

    const appearsSuccessful =
      /dashboard|student|profile/i.test(finalUrl) ||
      /dashboard|welcome|student/i.test(responseBody.substring(0, 2000));

    if (!appearsSuccessful || hasErrorAlert) {
      console.warn("[MAKAUT] Login FAILED — credentials rejected or error page returned");
      return res.json({
        verified: false,
        message: "Invalid MAKAUT credentials",
      });
    }

    console.log("[MAKAUT] Login SUCCEEDED — session cookies preserved");

    // ── NEW STEP: Fetch Dashboard explicitly ───────────────────────────────
    let dashboardCaptured = false;
    let dashboardHtmlLength = 0;
    let dashboardError = null;

    try {
      const dashboardUrl = `${BASE_URL}/student/dashboard`;
      console.log(`[MAKAUT] Fetching Dashboard → GET ${dashboardUrl}`);
      const dashboardRes = await client.get(dashboardUrl, {
        headers: { Referer: loginUrl },
        validateStatus: () => true,
      });
      
      const dashboardFinalUrl = dashboardRes.request?.res?.responseUrl ?? dashboardUrl;
      const dashboardHtmlRaw = dashboardRes.data;
      const dashboardHtml = typeof dashboardHtmlRaw === "string" ? dashboardHtmlRaw : JSON.stringify(dashboardHtmlRaw);
      dashboardHtmlLength = dashboardHtml.length;

      console.log(`[MAKAUT] Dashboard response — status: ${dashboardRes.status}, URL: ${dashboardFinalUrl}, body length: ${dashboardHtmlLength}`);

      const debugDirDashboard = path.join(__dirname, "debug");
      if (!fs.existsSync(debugDirDashboard)) {
        fs.mkdirSync(debugDirDashboard, { recursive: true });
      }
      const dashboardFilePath = path.join(debugDirDashboard, "dashboard.html");
      fs.writeFileSync(dashboardFilePath, dashboardHtml, "utf8");

      dashboardCaptured = true;
    } catch (dashErr) {
      console.error("[MAKAUT] Failed to capture dashboard:", dashErr.message);
      dashboardCaptured = false;
      dashboardError = dashErr.message;
    }

    // ── NEW STEP 1.5: Fetch CA Marks explicitly ──────────────────────────────
    let caMarksCaptured = false;
    let caMarksHtmlLength = 0;
    let caMarksError = null;

    try {
      const caMarksUrl = `${BASE_URL}/student/student-marks-display`;
      console.log(`[MAKAUT] Fetching CA Marks → GET ${caMarksUrl}`);
      const caMarksRes = await client.get(caMarksUrl, {
        headers: { Referer: `${BASE_URL}/student/dashboard` },
        validateStatus: () => true,
      });

      const caMarksHtmlRaw = caMarksRes.data;
      const caMarksHtml = typeof caMarksHtmlRaw === "string" ? caMarksHtmlRaw : JSON.stringify(caMarksHtmlRaw);
      caMarksHtmlLength = caMarksHtml.length;

      console.log(`[MAKAUT] CA Marks response — status: ${caMarksRes.status}, body length: ${caMarksHtmlLength}`);

      const debugDirDashboard = path.join(__dirname, "debug");
      if (!fs.existsSync(debugDirDashboard)) {
        fs.mkdirSync(debugDirDashboard, { recursive: true });
      }
      const caMarksFilePath = path.join(debugDirDashboard, "ca-marks.html");
      fs.writeFileSync(caMarksFilePath, caMarksHtml, "utf8");

      caMarksCaptured = true;
    } catch (caErr) {
      console.error("[MAKAUT] Failed to capture CA Marks:", caErr.message);
      caMarksCaptured = false;
      caMarksError = caErr.message;
    }

    // ── NEW STEP 1.6: Parse CA Marks ─────────────────────────────────────────
    let caMarksData = null;
    if (caMarksCaptured) {
      try {
        const caHtml = fs.readFileSync(path.join(__dirname, "debug", "ca-marks.html"), "utf8");
        caMarksData = extractCaMarks(caHtml);
        console.log(`[MAKAUT] Parsed CA Marks: ${caMarksData.semesters.length} semesters found.`);
      } catch (parseErr) {
        console.error("[MAKAUT] Failed to parse CA Marks:", parseErr.message);
      }
    }

    // ── NEW STEP 1.7: Fetch PCA Marks explicitly ─────────────────────────────
    let pcaMarksCaptured = false;
    let pcaMarksHtmlLength = 0;
    let pcaMarksError = null;

    try {
      const pcaMarksUrl = `${BASE_URL}/student/student-practical-assessment`;
      console.log(`[MAKAUT] Fetching PCA Marks → GET ${pcaMarksUrl}`);
      const pcaMarksRes = await client.get(pcaMarksUrl, {
        headers: { Referer: `${BASE_URL}/student/dashboard` },
        validateStatus: () => true,
      });

      const pcaMarksHtmlRaw = pcaMarksRes.data;
      const pcaMarksHtml = typeof pcaMarksHtmlRaw === "string" ? pcaMarksHtmlRaw : JSON.stringify(pcaMarksHtmlRaw);
      pcaMarksHtmlLength = pcaMarksHtml.length;

      console.log(`[MAKAUT] PCA Marks response — status: ${pcaMarksRes.status}, body length: ${pcaMarksHtmlLength}`);

      const debugDirDashboard = path.join(__dirname, "debug");
      if (!fs.existsSync(debugDirDashboard)) {
        fs.mkdirSync(debugDirDashboard, { recursive: true });
      }
      const pcaMarksFilePath = path.join(debugDirDashboard, "pca-marks.html");
      fs.writeFileSync(pcaMarksFilePath, pcaMarksHtml, "utf8");

      pcaMarksCaptured = true;
    } catch (pcaErr) {
      console.error("[MAKAUT] Failed to capture PCA Marks:", pcaErr.message);
      pcaMarksCaptured = false;
      pcaMarksError = pcaErr.message;
    }

    // ── NEW STEP 1.8: Parse PCA Marks & Merge ────────────────────────────────
    let pcaMarksData = null;
    if (pcaMarksCaptured) {
      try {
        const pcaHtml = fs.readFileSync(path.join(__dirname, "debug", "pca-marks.html"), "utf8");
        pcaMarksData = extractPcaMarks(pcaHtml);
        console.log(`[MAKAUT] Parsed PCA Marks: ${pcaMarksData.semesters.length} semesters found.`);
      } catch (parseErr) {
        console.error("[MAKAUT] Failed to parse PCA Marks:", parseErr.message);
      }
    }

    // ── NEW STEP 1.9: Fetch Result explicitly ─────────────────────────────
    let resultCaptured = false;
    let resultHtmlLength = 0;
    let resultError = null;

    try {
      const resultUrl = `${BASE_URL}/student/student-activity`;
      console.log(`[RESULT] Fetching Results/Activity → GET ${resultUrl}`);
      const resultRes = await client.get(resultUrl, {
        headers: { Referer: `${BASE_URL}/student/dashboard` },
        validateStatus: () => true,
      });

      const resultHtmlRaw = resultRes.data;
      const resultHtml = typeof resultHtmlRaw === "string" ? resultHtmlRaw : JSON.stringify(resultHtmlRaw);
      resultHtmlLength = resultHtml.length;

      console.log(`[RESULT] Results response — status: ${resultRes.status}, body length: ${resultHtmlLength}`);

      const debugDirDashboard = path.join(__dirname, "debug");
      if (!fs.existsSync(debugDirDashboard)) {
        fs.mkdirSync(debugDirDashboard, { recursive: true });
      }
      const resultFilePath = path.join(debugDirDashboard, "result.html");
      fs.writeFileSync(resultFilePath, resultHtml, "utf8");

      resultCaptured = true;
    } catch (resErr) {
      console.error("[RESULT] Failed to capture Results:", resErr.message);
      resultCaptured = false;
      resultError = resErr.message;
    }

    // Merge PCA data into CA data
    if (caMarksData && pcaMarksData) {
      caMarksData.semesters.forEach(sem => {
        const pcaSem = pcaMarksData.semesters.find(s => s.semester === sem.semester);
        if (pcaSem) {
          sem.subjects.forEach(sub => {
            const pcaSub = pcaSem.subjects.find(ps => ps.subject.toLowerCase() === sub.subject.toLowerCase());
            if (pcaSub) {
              console.log(`[MERGE] Semester ${sem.semester} | Match found for ${sub.subject}`);
              sub.pa1 = pcaSub.pa1;
              sub.pa2 = pcaSub.pa2;
              if (!sub.teacher && pcaSub.teacher) {
                sub.teacher = pcaSub.teacher;
              }
            }
          });
        }
      });
      // Also add any semester/subjects that only exist in PCA (rare but possible)
      pcaMarksData.semesters.forEach(pcaSem => {
        let sem = caMarksData.semesters.find(s => s.semester === pcaSem.semester);
        if (!sem) {
          sem = { semester: pcaSem.semester, subjects: [] };
          caMarksData.semesters.push(sem);
        }
        pcaSem.subjects.forEach(pcaSub => {
          const sub = sem.subjects.find(s => s.subject.toLowerCase() === pcaSub.subject.toLowerCase());
          if (!sub) {
            console.log(`[MERGE] Semester ${pcaSem.semester} | Adding PA-only subject ${pcaSub.subject}`);
            sem.subjects.push({
              subject: pcaSub.subject,
              subjectCode: pcaSub.subjectCode,
              teacher: pcaSub.teacher,
              ca1: null, ca2: null, ca3: null, ca4: null,
              pa1: pcaSub.pa1, pa2: pcaSub.pa2
            });
          }
        });
      });
    }

    // ── Step 5: Fetch student basic details page ───────────────────────────────
    const studentDetailsUrl = `${BASE_URL}/student/student-basic-details`;
    console.log(`[MAKAUT] Fetching student details → GET ${studentDetailsUrl}`);

    const detailsRes = await client.get(studentDetailsUrl, {
      headers: { Referer: loginUrl },
      validateStatus: () => true,
    });

    console.log(
      `[MAKAUT] Student details response — status: ${detailsRes.status}, body length: ${detailsRes.data.length}`
    );

    const detailsHtml =
      typeof detailsRes.data === "string"
        ? detailsRes.data
        : JSON.stringify(detailsRes.data);

    // ── Step 6: Save HTML for debugging (internal — not exposed in response) ──
    const debugDir = path.join(__dirname, "debug");
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    const debugFilePath = path.join(debugDir, "student-details.html");
    fs.writeFileSync(debugFilePath, detailsHtml, "utf8");
    console.log(`[MAKAUT] HTML saved → ${debugFilePath} (${detailsHtml.length} bytes)`);

    // ── Step 7: Log structural counts ─────────────────────────────────────────
    const $s = cheerio.load(detailsHtml);
    console.log("\n[MAKAUT] ─── HTML Structure ─────────────────────────────────");
    console.log(`  Page title : ${$s("title").text().trim() || "(none)"}`);
    console.log(`  <table>    : ${$s("table").length}`);
    console.log(`  <form>     : ${$s("form").length}`);
    console.log(`  <label>    : ${$s("label").length}`);
    console.log(`  <td>       : ${$s("td").length}`);
    console.log("[MAKAUT] ────────────────────────────────────────────────────\n");

    // ── Step 8: Extract student profile ───────────────────────────────────────
    const student = extractStudentData(detailsHtml);

    console.log("[MAKAUT] ─── Extracted Student Profile ──────────────────────");
    Object.entries(student).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    console.log("[MAKAUT] ────────────────────────────────────────────────────\n");

    // ── Step 8.5: Fetch and upload profile photo to Supabase ──────────────────
    if (student.profilePhotoUrl) {
      try {
        console.log(`[MAKAUT] Downloading profile photo from ${student.profilePhotoUrl} ...`);
        const photoRes = await axios.get(student.profilePhotoUrl, { responseType: 'arraybuffer' });
        
        const fileName = `${student.rollNumber}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from("student-profiles")
          .upload(fileName, photoRes.data, {
            contentType: photoRes.headers["content-type"] || "image/jpeg",
            upsert: true,
          });

        if (uploadError) {
          console.error("[SUPABASE] Photo upload failed:", uploadError.message);
          student.profilePhotoUrl = null;
        } else {
          const { data: publicUrlData } = supabase.storage
            .from("student-profiles")
            .getPublicUrl(fileName);
          student.profilePhotoUrl = publicUrlData.publicUrl;
          console.log(`[SUPABASE] Photo uploaded successfully: ${student.profilePhotoUrl}`);
        }
      } catch (err) {
        console.error("[MAKAUT] Photo download/upload failed:", err.message);
        student.profilePhotoUrl = null;
      }
    } else {
      student.profilePhotoUrl = null;
    }

    // ── Step 9: Upsert student into Supabase ──────────────────────────────────
    let savedToSupabase = false;

    const { error: upsertError } = await supabase
      .from("students")
      .upsert(
        {
          roll_number:          student.rollNumber,
          registration_number:  student.registrationNumber,
          full_name:            student.fullName,
          email:                student.email,
          mobile:               student.mobile,
          institute_name:       student.instituteName,
          course_name:          student.courseName,
          abc_id:               student.abcId,
          profile_photo_url:    student.profilePhotoUrl,
          verified:             true,
        },
        {
          onConflict: "roll_number", // update existing row if roll_number already exists
        }
      );

    if (upsertError) {
      console.error("[SUPABASE] FULL ERROR:", JSON.stringify(upsertError, null, 2));
      return res.json({
        verified: true,
        student,
        savedToSupabase: false,
        supabaseError: {
          message: upsertError.message,
          code:    upsertError.code,
          details: upsertError.details,
          hint:    upsertError.hint,
        },
      });
    }

    savedToSupabase = true;
    console.log(`[SUPABASE] Student upserted successfully (roll: ${student.rollNumber})`);

    // ── Step 9.5: Upsert CA Marks into Supabase ──────────────────────────────
    if (caMarksData && caMarksData.semesters.length > 0) {
      const marksRecords = [];
      let totalSubjectsParsed = 0;

      caMarksData.semesters.forEach(semBlock => {
        const semesterStr = String(semBlock.semester);
        console.log(`[MAKAUT] Semester ${semesterStr}: ${semBlock.subjects.length} subjects parsed.`);
        totalSubjectsParsed += semBlock.subjects.length;

        semBlock.subjects.forEach(sub => {
          marksRecords.push({
            roll_number: student.rollNumber,
            semester: semesterStr,
            subject_name: sub.subject,
            subject_code: sub.subjectCode,
            teacher: sub.teacher || null,
            ca1: sub.ca1 !== undefined ? sub.ca1 : null,
            ca2: sub.ca2 !== undefined ? sub.ca2 : null,
            ca3: sub.ca3 !== undefined ? sub.ca3 : null,
            ca4: sub.ca4 !== undefined ? sub.ca4 : null,
            pca1: sub.pa1 !== undefined ? sub.pa1 : null,
            pca2: sub.pa2 !== undefined ? sub.pa2 : null,
            ca_marks: null,
            pca_marks: null,
            total_marks: null,
            updated_at: new Date().toISOString()
          });
        });
      });

      // Insert into ca_marks. Since the unique constraint might be missing, 
      // we delete existing records for this student first to avoid duplicates.
      await supabase.from("ca_marks").delete().eq("roll_number", student.rollNumber);
      const { error: caUpsertError } = await supabase
        .from("ca_marks")
        .insert(marksRecords);

      if (caUpsertError) {
        console.error("[SUPABASE] Failed to upsert CA Marks:", caUpsertError.message);
      } else {
        console.log(`[SUPABASE] CA Marks upserted successfully. Saved ${marksRecords.length} rows to Supabase for roll: ${student.rollNumber}`);
      }
    }

    // ── Step 10: Return clean production response ─────────────────────────────
    return res.json({
      verified: true,
      student,
      savedToSupabase,
      supabaseError: null,
      dashboardCaptured,
      dashboardHtmlLength: dashboardCaptured ? dashboardHtmlLength : undefined,
      dashboardError: dashboardCaptured ? undefined : dashboardError,
      caMarksCaptured,
      caMarksHtmlLength: caMarksCaptured ? caMarksHtmlLength : undefined,
      caMarksError: caMarksCaptured ? undefined : caMarksError,
      resultCaptured,
      resultHtmlLength: resultCaptured ? resultHtmlLength : undefined,
      resultError: resultCaptured ? undefined : resultError
    });
  } catch (err) {
    console.error("[MAKAUT] Unexpected error:", err.message);
    return res.status(500).json({
      verified: false,
      message: "Internal server error during MAKAUT verification",
      error: err.message,
    });
  }
});

// ─── extractStudentData ───────────────────────────────────────────────────────
/**
 * Parses the MAKAUT student-basic-details HTML page.
 *
 * Page structure (confirmed from live HTML):
 *   <table id="table" …>
 *     <tbody>
 *       <tr>
 *         <td><b>Student Name</b></td>
 *         <td>ABDUR RAZZAQUE</td>
 *         <td rowspan="10">…photo…</td>   ← only on first row
 *       </tr>
 *       <tr>
 *         <td><b>Roll No</b></td>
 *         <td>27600124001</td>
 *       </tr>
 *       … (Reg. No, Email, Mobile, Father's Name, Mother's Name, DOB,
 *           Institute Name(Code), Course Name(Code), ABC ID)
 *     </tbody>
 *   </table>
 *
 * Strategy: build a label → value map by walking every <tr>, treating the
 * text inside the first <td> as the label key and the second <td> as the value.
 * This is resilient to row reordering.
 */
function extractStudentData(html) {
  const $ = cheerio.load(html);

  // Build a normalised label → value dictionary from the main data table
  const dict = {};
  $("table#table tbody tr, table.table tbody tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length < 2) return; // skip header / photo-only rows

    // The label cell always wraps text in <b>; fall back to raw text
    const labelEl = $(cells[0]);
    const label = (labelEl.find("b").first().text() || labelEl.text())
      .trim()
      .toLowerCase();

    // Value is the plain text of the second cell
    const value = $(cells[1]).text().trim();

    if (label) dict[label] = value;
  });

  console.log("[MAKAUT] Raw label→value dict:", dict);

  // ── Helper: safe lookup with multiple fallback keys ───────────────────────
  const pick = (...keys) => {
    for (const k of keys) {
      const v = dict[k.toLowerCase()];
      if (v) return v;
    }
    return "";
  };

  // ── Map to clean field names ───────────────────────────────────────────────
  const fullName            = pick("student name", "name");
  const rollNumber          = pick("roll no", "roll no.", "roll number");
  const registrationNumber  = pick("reg. no", "reg no", "registration no", "registration number");
  const email               = pick("email", "email id");
  const mobile              = pick("mobile", "mobile no", "phone", "contact");
  const instituteName       = pick("institute name(code)", "institute name", "college name");
  const courseName          = pick("course name(code)", "course name", "course");
  const abcId               = pick("abc id", "abc id.", "abc");

  // Extract photo URL
  let profilePhotoUrl = null;
  const photoImg = $("table#table tbody tr td[rowspan] img").first();
  if (photoImg.length) {
    profilePhotoUrl = photoImg.attr("src");
  }

  return {
    fullName,
    rollNumber,
    registrationNumber,
    email,
    mobile,
    instituteName,
    courseName,
    abcId,
    profilePhotoUrl,
    verified: true,
  };
}

// ─── extractCaMarks ──────────────────────────────────────────────────────────
function extractCaMarks(html) {
  const $ = cheerio.load(html);

  const semestersData = {};
  let currentSemesterStr = "";
  let currentSemesterNum = null;

  const parseSemester = (text) => {
    const lower = text.toLowerCase();
    if (lower.includes("first")) return 1;
    if (lower.includes("second")) return 2;
    if (lower.includes("third")) return 3;
    if (lower.includes("fourth")) return 4;
    if (lower.includes("fifth")) return 5;
    if (lower.includes("sixth")) return 6;
    if (lower.includes("seventh")) return 7;
    if (lower.includes("eighth")) return 8;
    return parseInt(text.replace(/\D/g, ""), 10) || null;
  };

  $("table tr").each((_, row) => {
    const text = $(row).text().trim();
    if (text.toLowerCase().includes("semester") && $(row).find("td").length === 1) {
      currentSemesterStr = text;
      currentSemesterNum = parseSemester(text);
      if (currentSemesterNum && !semestersData[currentSemesterNum]) {
        semestersData[currentSemesterNum] = [];
      }
      return;
    }

    const cells = $(row).find("td");
    if (cells.length >= 7 && currentSemesterNum) {
      const headerText = $(cells[0]).text().toLowerCase();
      if (headerText.includes("paper code") || headerText.includes("unique")) return;

      const fullCode = $(cells[0]).text().trim();
      const subjectCode = fullCode.split("(")[0].trim();
      const subjectName = $(cells[1]).text().trim();
      
      const parseMark = (val) => {
        const v = val.trim();
        return v === "" ? null : parseInt(v, 10);
      };

      const ca1 = parseMark($(cells[2]).text());
      const ca2 = parseMark($(cells[3]).text());
      const ca3 = parseMark($(cells[4]).text());
      const ca4 = parseMark($(cells[5]).text());
      const teacher = $(cells[6]).text().trim() || "";

      console.log(`[PARSER] Semester ${currentSemesterNum} | Subject ${subjectCode} | CA1: ${ca1} | CA2: ${ca2} | CA3: ${ca3} | CA4: ${ca4}`);

      const pcaMarks = null; // PCA marks not present on this page

      if (subjectName) {
        semestersData[currentSemesterNum].push({
          subject: subjectName,
          subjectCode: subjectCode,
          teacher: teacher,
          ca1: ca1,
          ca2: ca2,
          ca3: ca3,
          ca4: ca4,
          pcaMarks: pcaMarks,
          semester: currentSemesterNum
        });
      }
    }
  });

  const semesters = Object.keys(semestersData)
    .map(Number)
    .sort((a, b) => a - b)
    .map(sem => ({
      semester: sem,
      subjects: semestersData[sem]
    }));

  return {
    semesters
  };
}

// ─── extractPcaMarks ─────────────────────────────────────────────────────────
function extractPcaMarks(html) {
  const $ = cheerio.load(html);

  const semestersData = {};
  let currentSemesterStr = "";
  let currentSemesterNum = null;

  const parseSemester = (text) => {
    const lower = text.toLowerCase();
    if (lower.includes("first")) return 1;
    if (lower.includes("second")) return 2;
    if (lower.includes("third")) return 3;
    if (lower.includes("fourth")) return 4;
    if (lower.includes("fifth")) return 5;
    if (lower.includes("sixth")) return 6;
    if (lower.includes("seventh")) return 7;
    if (lower.includes("eighth")) return 8;
    return parseInt(text.replace(/\D/g, ""), 10) || null;
  };

  $("table tr").each((_, row) => {
    const text = $(row).text().trim();
    if (text.toLowerCase().includes("semester") && $(row).find("td").length === 1) {
      currentSemesterStr = text;
      currentSemesterNum = parseSemester(text);
      if (currentSemesterNum && !semestersData[currentSemesterNum]) {
        semestersData[currentSemesterNum] = [];
      }
      return;
    }

    const cells = $(row).find("td");
    if (cells.length >= 4 && currentSemesterNum) {
      const headerText = $(cells[0]).text().toLowerCase();
      if (headerText.includes("paper code") || headerText.includes("unique")) return;

      const fullCode = $(cells[0]).text().trim();
      const subjectCode = fullCode.split("(")[0].trim();
      const subjectName = $(cells[1]).text().trim();
      
      const parseMark = (val) => {
        const v = val.trim();
        return v === "" ? null : parseInt(v, 10);
      };

      const pa1 = parseMark($(cells[2]).text());
      const pa2 = parseMark($(cells[3]).text());
      const teacher = cells.length > 4 ? $(cells[4]).text().trim() : "";

      console.log(`[PARSER] Semester ${currentSemesterNum} | PA Subject ${subjectCode} | PA1: ${pa1} | PA2: ${pa2}`);

      if (subjectName) {
        semestersData[currentSemesterNum].push({
          subject: subjectName,
          subjectCode: subjectCode,
          teacher: teacher,
          pa1: pa1,
          pa2: pa2,
          semester: currentSemesterNum
        });
      }
    }
  });

  const semesters = Object.keys(semestersData)
    .map(Number)
    .sort((a, b) => a - b)
    .map(sem => ({
      semester: sem,
      subjects: semestersData[sem]
    }));

  return { semesters };
}

// ─── GET /debug/student-html — serve saved HTML for browser inspection ────────
app.get("/debug/student-html", (req, res) => {
  const debugFilePath = path.join(__dirname, "debug", "student-details.html");
  if (!fs.existsSync(debugFilePath)) {
    return res
      .status(404)
      .send("<h3>No saved HTML yet. POST /verify-student with real credentials first.</h3>");
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.sendFile(debugFilePath);
});

// ─── GET /parse-html — re-run extraction on saved file (dev convenience) ─────
app.get("/parse-html", (req, res) => {
  const debugFilePath = path.join(__dirname, "debug", "student-details.html");
  if (!fs.existsSync(debugFilePath)) {
    return res
      .status(404)
      .json({ error: "No saved HTML found. Call /verify-student first." });
  }
  const html    = fs.readFileSync(debugFilePath, "utf8");
  const student = extractStudentData(html);
  return res.json({ student });
});

// ─── GET /debug/ca-marks — parse captured CA marks (dev convenience) ─────────
app.get("/debug/ca-marks", (req, res) => {
  const debugFilePath = path.join(__dirname, "debug", "ca-marks.html");
  if (!fs.existsSync(debugFilePath)) {
    return res
      .status(404)
      .json({ error: "No saved ca-marks.html found. Call /verify-student first." });
  }
  const html = fs.readFileSync(debugFilePath, "utf8");
  
  try {
    const parsedData = extractCaMarks(html);
    return res.json({
      success: true,
      semesters: parsedData.semesters,
      rawHtmlLength: html.length
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Parsing failed", details: err.message });
  }
});

// ─── GET /debug/result — serve captured Result HTML ──────────────────────────
app.get("/debug/result", (req, res) => {
  const debugFilePath = path.join(__dirname, "debug", "result.html");
  if (!fs.existsSync(debugFilePath)) {
    return res
      .status(404)
      .json({ error: "No saved result.html found. Call /verify-student first." });
  }
  const html = fs.readFileSync(debugFilePath, "utf8");
  
  // Return raw HTML since parsing is not yet implemented
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ─── GET /debug/discovered-endpoints ──────────────────────────────────────────
app.get("/debug/discovered-endpoints", (req, res) => {
  const dashboardPath = path.join(__dirname, "debug", "dashboard.html");
  if (!fs.existsSync(dashboardPath)) {
    return res.status(404).json({ success: false, error: "No dashboard HTML found. Login first." });
  }

  const html = fs.readFileSync(dashboardPath, "utf8");
  const $ = cheerio.load(html);

  const BASE_URL = "https://makaut1.ucanapply.com/smartexam/public";
  
  let endpoints = [];

  const categorize = (name) => {
    const lower = name.toLowerCase();
    if (lower.includes("ca marks")) return "CA Marks";
    if (lower.includes("pca marks")) return "PCA Marks";
    if (lower.includes("review result")) return "Review Results";
    if (lower.includes("result")) return "Results";
    if (lower.includes("admit card")) return "Admit Card";
    if (lower.includes("exam form") || lower.includes("backlog form") || lower.includes("supplementary form")) return "Exam Form";
    if (lower.includes("enrollment")) return "Enrollment";
    if (lower.includes("student basic details")) return "Student Profile";
    if (lower.includes("mar") || lower.includes("mooc") || lower.includes("mentor") || lower.includes("abc id")) return "Academic Services";
    return "Other";
  };

  $("a.exmclick").each((_, el) => {
    const dataId = $(el).attr("data-id");
    if (!dataId) return;

    const fullUrl = `${BASE_URL}/student/${dataId}`;
    const name = $(el).text().replace(/\s+/g, " ").trim();
    
    if (name) {
      endpoints.push({ name, url: fullUrl, category: categorize(name) });
    }
  });

  // Also catch regular direct links that belong to the student portal
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.includes("/student/") && !$(el).hasClass("exmclick")) {
      const name = $(el).text().replace(/\s+/g, " ").trim();
      if (name) {
        endpoints.push({ name, url: href, category: categorize(name) });
      }
    }
  });

  console.log("\n[DISCOVERED]");
  endpoints.forEach(ep => {
    console.log(`${ep.name} -> ${ep.url}`);
  });
  console.log("");

  return res.json({
    success: true,
    endpoints
  });
});

// ─── GET /student/:rollNumber/ca-marks — Production API ───────────────────────
app.get("/student/:rollNumber/ca-marks", async (req, res) => {
  const { rollNumber } = req.params;

  console.log(`[API] GET /student/${rollNumber}/ca-marks requested`);

  try {
    const { data, error } = await supabase
      .from("ca_marks")
      .select("*")
      .eq("roll_number", rollNumber)
      .order("semester", { ascending: false });

    console.log(`[SUPABASE] Query ca_marks for ${rollNumber}: error=${error ? error.message : "null"}, rows_found=${data ? data.length : 0}`);

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    let marksData = data;

    // 5. If no rows exist: save parsed CA Marks immediately after successful verification.
    if (!marksData || marksData.length === 0) {
      console.log(`[API] No rows exist for ${rollNumber}. Attempting to parse and save from debug/ca-marks.html`);
      const debugFilePath = path.join(__dirname, "debug", "ca-marks.html");
      if (fs.existsSync(debugFilePath)) {
        try {
          const html = fs.readFileSync(debugFilePath, "utf8");
          const parsedData = extractCaMarks(html);

          if (parsedData && parsedData.semesters && parsedData.semesters.length > 0) {
            const marksRecords = [];
            parsedData.semesters.forEach(semBlock => {
              const semesterStr = String(semBlock.semester);
              semBlock.subjects.forEach(sub => {
                marksRecords.push({
                  roll_number: rollNumber,
                  semester: semesterStr,
                  subject_name: sub.subject,
                  subject_code: sub.subjectCode,
                  teacher: sub.teacher || null,
                  ca1: sub.ca1 !== undefined ? sub.ca1 : null,
                  ca2: sub.ca2 !== undefined ? sub.ca2 : null,
                  ca3: sub.ca3 !== undefined ? sub.ca3 : null,
                  ca4: sub.ca4 !== undefined ? sub.ca4 : null,
                  pca1: sub.pa1 !== undefined ? sub.pa1 : null,
                  pca2: sub.pa2 !== undefined ? sub.pa2 : null,
                  updated_at: new Date().toISOString()
                });
              });
            });

            console.log(`[API] Prepared ${marksRecords.length} rows for upserting.`);
            await supabase.from("ca_marks").delete().eq("roll_number", rollNumber);
            const { error: caUpsertError } = await supabase
              .from("ca_marks")
              .insert(marksRecords);

            if (caUpsertError) {
              console.error("[SUPABASE] Failed to upsert CA Marks fallback:", caUpsertError.message);
            } else {
              console.log(`[SUPABASE] CA Marks fallback upsert successful. Reloading data...`);
              const { data: refetchedData } = await supabase
                .from("ca_marks")
                .select("*")
                .eq("roll_number", rollNumber)
                .order("semester", { ascending: false });

              if (refetchedData) {
                marksData = refetchedData;
              }
            }
          }
        } catch (parseErr) {
          console.error("[API] Error parsing fallback CA Marks:", parseErr.message);
        }
      } else {
        console.log(`[API] Fallback failed: debug/ca-marks.html not found`);
      }
    }

    if (!marksData || marksData.length === 0) {
      return res.json({ success: true, semesters: [] });
    }

    const semestersMap = {};
    marksData.forEach(item => {
      if (!semestersMap[item.semester]) semestersMap[item.semester] = [];
      semestersMap[item.semester].push({
        subjectCode: item.subject_code,
        subjectName: item.subject_name,
        teacher: item.teacher || "",
        ca1: item.ca1,
        ca2: item.ca2,
        ca3: item.ca3,
        ca4: item.ca4,
        pa1: item.pca1,
        pa2: item.pca2
      });
    });

    const semesters = Object.keys(semestersMap)
      .sort((a, b) => Number(b) - Number(a)) // sort descending
      .map(sem => ({
        semester: String(sem),
        subjects: semestersMap[sem]
      }));

    console.log(`[API] Returning data for ${rollNumber}:`, {
      rowsReturned: marksData.length,
      semestersGrouped: semesters.map(s => ({ semester: s.semester, subjectCount: s.subjects.length }))
    });

    return res.json({
      success: true,
      semesters
    });
  } catch (err) {
    console.error("[API] Error in GET CA Marks:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /debug/ca-marks-db/:rollNumber — Temporary Debug API ─────────────────
app.get("/debug/ca-marks-db/:rollNumber", async (req, res) => {
  const { rollNumber } = req.params;
  try {
    const { data, error } = await supabase
      .from("ca_marks")
      .select("*")
      .eq("roll_number", rollNumber);
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    return res.json({ success: true, count: data ? data.length : 0, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /student/:rollNumber/internal-marks — Production API ─────────────────
app.get("/student/:rollNumber/internal-marks", async (req, res) => {
  const { rollNumber } = req.params;
  console.log(`[API] GET /student/${rollNumber}/internal-marks requested`);

  try {
    const { data, error } = await supabase
      .from("ca_marks")
      .select("*")
      .eq("roll_number", rollNumber)
      .order("semester", { ascending: false });

    console.log(`[SUPABASE] Query internal marks for ${rollNumber}: error=${error ? error.message : "null"}, rows_found=${data ? data.length : 0}`);

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    if (!data || data.length === 0) {
      return res.json({ success: true, semesters: [] });
    }

    const semestersMap = {};
    data.forEach(item => {
      if (!semestersMap[item.semester]) semestersMap[item.semester] = [];
      semestersMap[item.semester].push({
        subjectCode: item.subject_code || "",
        subjectName: item.subject_name || "",
        teacher: item.teacher || "",
        ca1: item.ca1 !== null ? item.ca1 : null,
        ca2: item.ca2 !== null ? item.ca2 : null,
        ca3: item.ca3 !== null ? item.ca3 : null,
        ca4: item.ca4 !== null ? item.ca4 : null,
        pa1: item.pca1 !== null ? item.pca1 : null,
        pa2: item.pca2 !== null ? item.pca2 : null
      });
    });

    const semesters = Object.keys(semestersMap)
      .sort((a, b) => Number(b) - Number(a)) // sort descending
      .map(sem => ({
        semester: Number(sem),
        subjects: semestersMap[sem]
      }));

    console.log(`[API] Returning internal marks for ${rollNumber}:`, {
      rowsReturned: data.length,
      semestersGrouped: semesters.map(s => ({ semester: s.semester, subjectCount: s.subjects.length }))
    });

    return res.json({
      success: true,
      semesters
    });
  } catch (err) {
    console.error("[API] Error in GET internal marks:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /verify/:studentId — Verification API ────────────────────────────────
app.get("/verify/:studentId", async (req, res) => {
  const { studentId } = req.params;
  console.log(`[API] GET /verify/${studentId} requested`);

  try {
    const { data, error } = await supabase
      .from("students")
      .select("*")
      .eq("roll_number", studentId)
      .single();

    if (error || !data) {
      console.log(`[API] Verification failed for ${studentId}: not found`);
      return res.json({ verified: false, message: "Student not found" });
    }

    return res.json({
      verified: true,
      student: {
        rollNumber: data.roll_number,
        registrationNumber: data.registration_number,
        fullName: data.full_name,
        email: data.email,
        mobile: data.mobile,
        instituteName: data.institute_name,
        courseName: data.course_name,
        abcId: data.abc_id,
        profilePhotoUrl: data.profile_photo_url
      }
    });
  } catch (err) {
    console.error("[API] Error in verify endpoint:", err.message);
    return res.status(500).json({ verified: false, message: "Internal server error" });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log("Server running on port 3000");
});