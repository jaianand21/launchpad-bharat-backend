import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Missing SUPABASE_URL or SUPABASE_KEY — database features disabled. AI endpoints still work.');
} else {
  supabase = createClient(supabaseUrl, supabaseKey);
}

export { supabase };
export default supabase;

// Supabase creates its own tables via the SQL Editor, so initDb is mostly for seeding or logging
export const initDb = async () => {
    if (!supabase) {
      console.log('⚠️ Skipping DB init — no Supabase credentials.');
      return;
    }
    console.log('✅ Supabase Client ready. Ensure your tables are created in the Supabase SQL Editor.');
    
    // Check if documents table needs seeding
    const { data: documents, error } = await supabase.from('documents').select('id').limit(1);
    
    if (error) {
        console.error('❌ Error checking documents table:', error.message);
        return;
    }

    if (documents.length === 0) {
        console.log('🌱 Seeding initial documents...');
        const seedDocs = [
            {
                title: 'GST Registration Manual',
                description: 'Official step-by-step PDF to register for GST.',
                category: 'Government Schemes',
                official_source_url: 'https://cbic-gst.gov.in/pdf/registration-manual.pdf',
                fallback_file_url: '/mock-pdfs/gst-registration.pdf'
            },
            {
                title: 'Mudra Loan Application',
                description: 'Blank official form for Mudra bank loans.',
                category: 'Government Schemes',
                official_source_url: 'https://www.mudra.org.in/pdf/MUDRA-Application-Form.pdf',
                fallback_file_url: '/mock-pdfs/mudra-loan.pdf'
            },
            {
                title: 'Founder Agreement Template',
                description: 'Standard NDA and Equity Split agreement.',
                category: 'Legal & Documentation',
                official_source_url: 'https://www.startupindia.gov.in/content/dam/invest-india/Templates/public/Founders_Agreement.pdf',
                fallback_file_url: '/mock-pdfs/founder-agreement.pdf'
            }
        ];
        
        await supabase.from('documents').insert(seedDocs);
    }
};
