import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing credentials in .env file!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const tables = ['user_plans', 'blueprint_outcomes', 'testimonials', 'calculator_results', 'expert_reviews'];
  for (const table of tables) {
    try {
      const { data, error } = await supabase.from(table).select('id').limit(1);
      if (error) {
        console.log(`❌ Table ${table}: error: ${error.message} (code: ${error.code})`);
      } else {
        console.log(`✅ Table ${table}: exists`);
      }
    } catch (err) {
      console.log(`❌ Table ${table}: exception: ${err.message}`);
    }
  }
}

check();
