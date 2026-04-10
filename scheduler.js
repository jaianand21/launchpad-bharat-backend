import cron from 'node-cron';
import axios from 'axios';
import { supabase } from './db.js';

// Executes every 24 hours at midnight
export const initScheduler = () => {
  cron.schedule('0 0 * * *', () => {
    console.log('[CRON] Initiating automated Founder Library verification cycle...');
    manuallySyncAllDocuments();
  });
};

export const manuallySyncAllDocuments = async () => {
  try {
    const { data: docs, error: fetchError } = await supabase
      .from('documents')
      .select('*')
      .eq('is_active', true);

    if (fetchError) throw fetchError;

    for (const doc of docs) {
      try {
        console.log(`[SYNCHRONIZER] Pinging Govt source for: ${doc.title}...`);
        
        // HEAD request to check for updates
        const response = await axios.head(doc.official_source_url, { timeout: 8000 });
        
        const newLength = response.headers['content-length'] || '';
        const newModified = response.headers['last-modified'] || '';
        const compositeHash = `${newLength}-${newModified}`;

        if (doc.content_hash_cache !== compositeHash) {
          console.log(`[SYNCHRONIZER] 🚨 UPDATE DETECTED for ${doc.title}!`);
          await supabase
            .from('documents')
            .update({ 
              content_hash_cache: compositeHash, 
              last_updated_at: new Date().toISOString(), 
              last_checked_at: new Date().toISOString(), 
              version: doc.version + 1 
            })
            .eq('id', doc.id);
        } else {
          console.log(`[SYNCHRONIZER] Source identical for ${doc.title}.`);
          await supabase
            .from('documents')
            .update({ last_checked_at: new Date().toISOString() })
            .eq('id', doc.id);
        }
      } catch (error) {
        console.error(`[SYNCHRONIZER] ❌ Failed to ping source for ${doc.title}.`);
        await supabase
          .from('documents')
          .update({ last_checked_at: new Date().toISOString() })
          .eq('id', doc.id);
      }
    }
  } catch (err) {
    console.error('[CRON] Scheduler error:', err.message);
  }
};
