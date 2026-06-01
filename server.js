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

    // ── Step 10: Return clean production response ─────────────────────────────
    return res.json({
      verified: true,
      student,
      savedToSupabase,
      supabaseError: null,
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

  return {
    fullName,
    rollNumber,
    registrationNumber,
    email,
    mobile,
    instituteName,
    courseName,
    abcId,
    verified: true,
  };
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

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log("Server running on port 3000");
});