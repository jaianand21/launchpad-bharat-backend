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
  db.all('SELECT * FROM documents WHERE is_active = 1', async (err, docs) => {
    if (err) {
      console.error('[CRON] Database error during sync retrieval');
      return;
    }

    for (const doc of docs) {
      try {
        console.log(`[SYNCHRONIZER] Pinging Govt source for: ${doc.title}...`);
        
        // Execute HTTP HEAD Request (minimal payload, fast) to detect metadata changes seamlessly
        const response = await axios.head(doc.official_source_url, { timeout: 8000 });
        
        const newLength = response.headers['content-length'] || '';
        const newModified = response.headers['last-modified'] || '';
        const compositeHash = `${newLength}-${newModified}`;

        // If data differs from cache, it was updated officially!
        if (doc.content_hash_cache !== compositeHash) {
          console.log(`[SYNCHRONIZER] 🚨 UPDATE DETECTED for ${doc.title}! Iterating version structure.`);
          db.run(
            `UPDATE documents 
             SET content_hash_cache = ?, last_updated_at = CURRENT_TIMESTAMP, last_checked_at = CURRENT_TIMESTAMP, version = version + 1 
             WHERE id = ?`,
            [compositeHash, doc.id]
          );
        } else {
          // Unchanged, just update check time
          console.log(`[SYNCHRONIZER] Source identical for ${doc.title}. Status: Verified.`);
          db.run('UPDATE documents SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?', [doc.id]);
        }
      } catch (error) {
        // If official URL fails or times out, we silently log the failure.
        // The React UI handles broken links explicitly using our 'fallback_file_url'.
        console.error(`[SYNCHRONIZER] ❌ Failed to ping source for ${doc.title}. UI will deploy localized CDN fallback.`);
        db.run('UPDATE documents SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?', [doc.id]);
      }
    }
  });
};
