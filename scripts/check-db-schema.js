const { createClient } = require('@supabase/supabase-js');

// Load environment variables
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkCreatedTokensTable() {
  try {
    console.log('🔍 Checking created_tokens table...');
    const { data, error } = await supabase
      .from('created_tokens')
      .select('*')
      .limit(3);

    if (error) {
      console.error('❌ Error fetching created_tokens:', error);
      return;
    }

    if (!data || data.length === 0) {
      console.log('No rows found in created_tokens table.');
      return;
    }

    console.log('Sample rows:');
    data.forEach((row, i) => {
      console.log(`Row ${i + 1}:`);
      Object.keys(row).forEach(key => {
        console.log(`  ${key}: ${row[key]}`);
      });
    });

    // Check for required columns
    const sample = data[0];
    const required = ['status', 'transaction_error', 'confirmed_at'];
    required.forEach(col => {
      if (sample.hasOwnProperty(col)) {
        console.log(`✅ Column "${col}" exists`);
      } else {
        console.log(`❌ Column "${col}" is missing`);
      }
    });
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkCreatedTokensTable(); 