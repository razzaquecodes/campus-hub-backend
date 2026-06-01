require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
(async () => {
  const { data, error } = await supabase.from("ca_marks").select("*").eq("roll_number", "27600124001");
  console.log("Error:", error);
  console.log("Rows:", data ? data.length : 0);
  console.log("Data:", data);
})();
