import sqlite3 from 'sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

export const initDb = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Users table with mobile_number constraint
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          email TEXT UNIQUE,
          mobile_number TEXT UNIQUE,
          google_id TEXT UNIQUE,
          profile_picture TEXT,
          auth_provider TEXT NOT NULL,
          password_hash TEXT,
          is_mobile_verified BOOLEAN DEFAULT 0,
          business_stage TEXT,
          business_type TEXT,
          goal TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) return reject(err);

        // Safely add columns for existing databases (idempotent)
        db.run(`ALTER TABLE users ADD COLUMN password_hash TEXT`, () => {});
        db.run(`ALTER TABLE users ADD COLUMN last_login DATETIME`, () => {});
      });

      // Strict OTP Rate Limiting & Verification Table
      db.run(`
        CREATE TABLE IF NOT EXISTS otps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mobile_number TEXT NOT NULL,
          otp_hash TEXT NOT NULL,
          expires_at DATETIME NOT NULL,
          attempt_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) return reject(err);
      });

      // Dynamic Documents Table (Govt Resources)
      db.run(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          category TEXT NOT NULL,
          official_source_url TEXT NOT NULL,
          fallback_file_url TEXT,
          last_checked_at DATETIME,
          last_updated_at DATETIME,
          content_hash_cache TEXT,
          version INTEGER DEFAULT 1,
          is_active BOOLEAN DEFAULT 1
        )
      `, (err) => {
        if (err) return reject(err);
        
        // Seed database if empty
        db.get('SELECT COUNT(*) as count FROM documents', (err, row) => {
          if (!err && row.count === 0) {
            const seedDocs = [
              {
                title: 'GST Registration Manual',
                description: 'Official step-by-step PDF to register for GST.',
                category: 'Government Schemes',
                url: 'https://cbic-gst.gov.in/pdf/registration-manual.pdf', // valid proxy or mock
                fallback: '/mock-pdfs/gst-registration.pdf'
              },
              {
                title: 'Mudra Loan Application',
                description: 'Blank official form for Mudra bank loans.',
                category: 'Government Schemes',
                url: 'https://www.mudra.org.in/pdf/MUDRA-Application-Form.pdf',
                fallback: '/mock-pdfs/mudra-loan.pdf'
              },
              {
                title: 'Founder Agreement Template',
                description: 'Standard NDA and Equity Split agreement.',
                category: 'Legal & Documentation',
                url: 'https://www.startupindia.gov.in/content/dam/invest-india/Templates/public/Founders_Agreement.pdf',
                fallback: '/mock-pdfs/founder-agreement.pdf'
              }
            ];
            
            const stmt = db.prepare('INSERT INTO documents (title, description, category, official_source_url, fallback_file_url) VALUES (?, ?, ?, ?, ?)');
            seedDocs.forEach(d => {
              stmt.run(d.title, d.description, d.category, d.url, d.fallback);
            });
            stmt.finalize();
          }
        });

        // ── Leads Table (Welcome Modal capture) ──────────────────────────
        db.run(`
          CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            mobile TEXT NOT NULL,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  });
};

export default db;
