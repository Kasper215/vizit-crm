const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

const list = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
const config = Object.freeze({
  root,
  dataDir: path.join(root, 'data'),
  databasePath: path.resolve(root, process.env.DATABASE_PATH || 'data/crm.sqlite'),
  uploadsDir: path.join(root, 'data', 'telegram-files'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4173),
  crmUrl: (process.env.CRM_URL || `http://127.0.0.1:${process.env.PORT || 4173}`).replace(/\/$/, ''),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramWebappUrl: process.env.TELEGRAM_WEBAPP_URL || '',
  allowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID || '',
  allowedUserIds: new Set(list(process.env.TELEGRAM_ALLOWED_USER_IDS)),
  serviceToken: process.env.CRM_API_TOKEN || '',
  webPassword: process.env.CRM_WEB_PASSWORD || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  digestTime: process.env.TELEGRAM_DIGEST_TIME || '09:00',
  timeZone: process.env.TELEGRAM_TIMEZONE || 'Europe/Moscow',
  transcriptionApiKey: process.env.OPENAI_API_KEY || '',
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe'
});

module.exports = config;
