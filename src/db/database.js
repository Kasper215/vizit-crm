const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });
const db = new DatabaseSync(config.databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    business TEXT NOT NULL,
    phone_key TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL,
    deadline TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_applications_stage_deadline ON applications(stage, deadline);
  CREATE INDEX IF NOT EXISTS idx_applications_phone_key ON applications(phone_key);
`);

function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function saveRow(row) {
  db.prepare(`INSERT INTO applications(id,business,phone_key,stage,deadline,data,created_at,updated_at)
    VALUES(@id,@business,@phoneKey,@stage,@deadline,@data,@createdAt,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET business=excluded.business, phone_key=excluded.phone_key,
    stage=excluded.stage, deadline=excluded.deadline, data=excluded.data, updated_at=excluded.updated_at`)
    .run({
      id: row.id, business: row.business, phoneKey: phoneKey(row.phone), stage: row.stage,
      deadline: row.deadline || '', data: JSON.stringify(row), createdAt: row.createdAt, updatedAt: row.updatedAt
    });
}

const count = db.prepare('SELECT count(*) AS total FROM applications').get().total;
const legacyPath = path.join(config.dataDir, 'applications.json');
if (!count && fs.existsSync(legacyPath)) {
  const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  const migrate = db.transaction(rows => { for (const row of rows) if (row?.id && row?.business) saveRow(row); });
  migrate(Array.isArray(legacy) ? legacy : []);
  console.log(`Перенесено заявок из applications.json: ${db.prepare('SELECT count(*) AS total FROM applications').get().total}`);
}

module.exports = { db, phoneKey, saveRow };
