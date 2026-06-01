require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
(async () => {
  const { data, error } = await supabase.rpc("get_table_constraints", { table_name: "ca_marks" });
  console.log("RPC Error:", error);
  if (error) {
     const { data: d2, error: e2 } = await supabase.from('ca_marks').select('*').limit(1);
     console.log("e2:", e2);
  }
})();
