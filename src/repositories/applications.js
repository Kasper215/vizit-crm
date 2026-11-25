const { randomUUID } = require('node:crypto');
const { db, phoneKey, saveRow } = require('../db/database');

const stages = ['Новая', 'На связи', 'Материалы', 'В редакции', 'Опубликована', 'Закрыта'];
const fields = { business: 160, category: 100, contact: 160, phone: 40, email: 180, instagram: 100, source: 100, notes: 5000, pdfText: 12000, deadline: 10 };

function list() {
  return db.prepare('SELECT data FROM applications ORDER BY updated_at DESC, created_at DESC').all().map(row => JSON.parse(row.data));
}

function get(id) {
  const row = db.prepare('SELECT data FROM applications WHERE id=?').get(id);
  return row ? JSON.parse(row.data) : null;
}

function findByPhone(phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  return db.prepare('SELECT data FROM applications WHERE phone_key=? ORDER BY updated_at DESC LIMIT 8').all(key).map(row => JSON.parse(row.data));
}

function save(input, method = 'POST') {
  if (method === 'POST' && typeof input.externalId === 'string') {
    const priorExternal = list().find(item => item.externalIds?.includes(input.externalId) || item.externalId === input.externalId);
    if (priorExternal) return priorExternal;
  }
  const current = input.id ? get(String(input.id)) : null;
  const record = {};
  for (const [key, limit] of Object.entries(fields)) record[key] = typeof input[key] === 'string' ? input[key].trim().slice(0, limit) : '';
  if (!record.business || !stages.includes(input.stage)) throw new Error('Укажите название и статус заявки');
  if (record.deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(record.deadline) || Number.isNaN(Date.parse(record.deadline)))) throw new Error('Проверьте дату');

  const incomingPhone = phoneKey(record.phone);
  const replyId = String(input.replyToMessageId || '');
  const match = current || (method === 'POST' && !input.forceNew && record.source.startsWith('Telegram') ? list().find(item =>
    (incomingPhone && phoneKey(item.phone) === incomingPhone)
    || (replyId && item.telegramMessages?.some(message => String(message.messageId) === replyId))) : null);
  if (method === 'PUT' && !match) throw Object.assign(new Error('Заявка не найдена'), { status: 404 });

  const now = new Date().toISOString();
  const history = match ? [...(match.history || [])] : [];
  if (!match || match.stage !== input.stage) history.unshift({ date: now, stage: input.stage });
  const incomingDocs = Array.isArray(input.documents) ? input.documents.filter(doc => doc && typeof doc.id === 'string'
    && /^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/i.test(doc.id) && typeof doc.name === 'string')
    .map(doc => ({ id: doc.id, name: doc.name.slice(0, 180) })) : [];
  const documents = [...(match?.documents || [])];
  for (const doc of incomingDocs) if (!documents.some(item => item.id === doc.id)) documents.push(doc);
  const telegramMessages = [...(match?.telegramMessages || [])];
  if (input.telegramMessage && typeof input.telegramMessage.messageId === 'number' && !telegramMessages.some(item => item.messageId === input.telegramMessage.messageId && item.chatId === String(input.telegramMessage.chatId || ''))) {
    telegramMessages.unshift({
      chatId: String(input.telegramMessage.chatId || ''), messageId: input.telegramMessage.messageId,
      threadId: Number(input.telegramMessage.threadId || 0),
      link: typeof input.telegramMessage.link === 'string' ? input.telegramMessage.link.slice(0, 500) : '',
      date: typeof input.telegramMessage.date === 'string' ? input.telegramMessage.date.slice(0, 40) : now,
      author: typeof input.telegramMessage.author === 'string' ? input.telegramMessage.author.slice(0, 160) : ''
    });
  }
  const sourceNote = typeof input.appendNote === 'string' ? input.appendNote.trim().slice(0, 5000) : '';
  const saved = {
    ...record,
    business: match?.business || record.business,
    category: record.category || match?.category || '', contact: record.contact || match?.contact || '',
    phone: record.phone || match?.phone || '', email: record.email || match?.email || '',
    instagram: record.instagram || match?.instagram || '', source: record.source || match?.source || '',
    notes: match && sourceNote ? `${match.notes || ''}\n\n${sourceNote}`.trim().slice(0, 5000) : record.notes || match?.notes || '',
    pdfText: record.pdfText || match?.pdfText || '', documents, telegramMessages,
    externalIds: [...new Set([...(match?.externalIds || (match?.externalId ? [match.externalId] : [])), ...(typeof input.externalId === 'string' ? [input.externalId.slice(0, 160)] : [])])],
    id: match?.id || randomUUID(), stage: match?.stage || input.stage,
    createdAt: match?.createdAt || now, updatedAt: now, history
  };
  saveRow(saved);
  return saved;
}

module.exports = { stages, list, get, findByPhone, save };
