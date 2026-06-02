require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase.from('ca_marks').select('teacher').limit(1);
  if (error) {
    console.log("Error selecting teacher:", error.message);
    if (error.message.includes("Could not find the 'teacher' column")) {
       console.log("Teacher column needs to be created.");
    }
  } else {
    console.log("Teacher column exists.");
  }
}
run();
