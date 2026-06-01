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

  await supabase.from("ca_marks").delete().eq("roll_number", "27600124001");
  const { error: e1 } = await supabase.from("ca_marks").insert(marksRecords);
  console.log("Insert error:", e1);
  const { data } = await supabase.from("ca_marks").select("*").eq("roll_number", "27600124001");
  console.log("Data:", data);
})();
