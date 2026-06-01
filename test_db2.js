require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
(async () => {
  const marksRecords = [{
    roll_number: "27600124001",
    semester: "1",
    subject_code: "TEST101",
    subject_name: "Test Subject",
    ca_marks: 20,
    pca_marks: null,
    total_marks: 20,
    updated_at: new Date().toISOString()
  }];

  const { error: e1 } = await supabase
    .from("ca_marks")
    .upsert(marksRecords, {
      onConflict: "ca_marks_roll_semester_subject_key"
    });
  console.log("Upsert with constraint name error:", e1);
})();
