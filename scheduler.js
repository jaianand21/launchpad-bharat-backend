import cron from 'node-cron';
import axios from 'axios';
import db from './db.js';

// Executes every 24 hours at midnight
export const initScheduler = () => {
  cron.schedule('0 0 * * *', () => {
    console.log('[CRON] Initiating automated Founder Library verification cycle...');
    manuallySyncAllDocuments();
  });
};

export const manuallySyncAllDocuments = () => {
  try {
    const docs = db.prepare('SELECT * FROM documents WHERE is_active = 1').all();

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
          db.prepare(`
            UPDATE documents 
            SET content_hash_cache = ?, last_updated_at = CURRENT_TIMESTAMP, last_checked_at = CURRENT_TIMESTAMP, version = version + 1 
            WHERE id = ?
          `).run(compositeHash, doc.id);
        } else {
          console.log(`[SYNCHRONIZER] Source identical for ${doc.title}.`);
          db.prepare('UPDATE documents SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?').run(doc.id);
        }
      } catch (error) {
        console.error(`[SYNCHRONIZER] ❌ Failed to ping source for ${doc.title}.`);
        db.prepare('UPDATE documents SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?').run(doc.id);
      }
    }
  } catch (err) {
    console.error('[CRON] Scheduler error:', err.message);
  }
};
