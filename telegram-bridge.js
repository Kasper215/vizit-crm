const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const config = require('./src/config');

const root = __dirname;
const dataDir = path.join(root, 'data');
const filesDir = config.uploadsDir;
fs.mkdirSync(filesDir, { recursive: true });

const token = config.telegramToken;
const allowedChat = config.allowedChatId;
const allowedUserIds = config.allowedUserIds;
const crmUrl = config.crmUrl;
const python = process.env.PYTHON_EXECUTABLE || 'python';
let topicMap = {};
try { topicMap = JSON.parse(process.env.TELEGRAM_TOPIC_MAP || '{}'); }
catch { console.error('TELEGRAM_TOPIC_MAP должен содержать JSON-объект'); }

if (!token || token.includes('вставьте_')) {
  console.error('Заполните TELEGRAM_BOT_TOKEN в файле .env');
  process.exit(1);
}

const api = `https://api.telegram.org/bot${token}`;
const offsetPath = path.join(dataDir, 'telegram-offset.json');
const pendingPath = path.join(dataDir, 'telegram-pending.json');
const sessionsPath = path.join(dataDir, 'telegram-sessions.json');
const schedulePath = path.join(dataDir, 'telegram-schedule.json');
let offset = fs.existsSync(offsetPath) ? Number(JSON.parse(fs.readFileSync(offsetPath, 'utf8')).offset || 0) : 0;
let pending = fs.existsSync(pendingPath) ? JSON.parse(fs.readFileSync(pendingPath, 'utf8')) : {};
let sessions = fs.existsSync(sessionsPath) ? JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) : {};
let scheduleState = fs.existsSync(schedulePath) ? JSON.parse(fs.readFileSync(schedulePath, 'utf8')) : {};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const stages = ['Новая', 'На связи', 'Материалы', 'В редакции', 'Опубликована', 'Закрыта'];

function persistPending() {
  const temporary = pendingPath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(pending, null, 2));
  fs.renameSync(temporary, pendingPath);
}

function persistSessions() {
  const temporary = sessionsPath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(sessions, null, 2));
  fs.renameSync(temporary, sessionsPath);
}

function persistSchedule() {
  const temporary = schedulePath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(scheduleState, null, 2));
  fs.renameSync(temporary, schedulePath);
}

async function telegram(method, payload = {}) {
  const response = await fetch(`${api}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${response.status}`);
  return result.result;
}

async function crm(method = 'GET', body) {
  const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(config.serviceToken ? { Authorization: `Bearer ${config.serviceToken}` } : {}) };
  const response = await fetch(`${crmUrl}/api/applications`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'CRM не ответила');
  return result;
}

function send(chatId, text, extra = {}) {
  return telegram('sendMessage', { chat_id: chatId, text, ...extra });
}

function messageText(message) {
  return message.text || message.caption || '';
}

function extractPhone(text) {
  const matches = String(text || '').match(/(?:\+?7|8)?[\s().-]*(?:\d[\s().-]*){10,11}/g) || [];
  for (const match of matches) {
    const digits = match.replace(/\D/g, '');
    if (digits.length === 11 && /^[78]/.test(digits)) return '+7' + digits.slice(1);
    if (digits.length === 10) return '+7' + digits;
  }
  return '';
}

function removePhones(text) {
  return String(text || '').replace(/(?:\+?7|8)?[\s().-]*(?:\d[\s().-]*){10,11}/g, ' ')
    .replace(/^[\s,;:—-]+|[\s,;:—-]+$/g, '').trim();
}

function attachments(message) {
  if (message.document) return [{ file: message.document, name: message.document.file_name || 'Документ' }];
  if (message.photo?.length) return [{ file: message.photo.at(-1), name: `Фото ${message.message_id}.jpg` }];
  if (message.video) return [{ file: message.video, name: message.video.file_name || `Видео ${message.message_id}.mp4` }];
  if (message.voice) return [{ file: message.voice, name: `Голосовая заметка ${message.message_id}.oga` }];
  if (message.audio) return [{ file: message.audio, name: message.audio.file_name || `Аудио ${message.message_id}.mp3` }];
  return [];
}

function parseFilename(filename) {
  const clean = filename.replace(/\.[^.]+$/, '').replace(/^Заявка_на_Маршрутизатор[, _]*/i, '').replaceAll('_', ' ').trim();
  const categories = ['Народно художественное творчество', 'Гостиницы и отели', 'Перевозки', 'Рестораны', 'Ресторан', 'Кафе', 'Бьюти', 'Разное', 'НХП'];
  const normalized = clean.toLocaleLowerCase('ru-RU');
  const category = categories.find(candidate => normalized.startsWith(candidate.toLocaleLowerCase('ru-RU')));
  return { category: category || '', business: category ? clean.slice(category.length).replace(/^[\s,.-]+/, '').trim() : clean };
}

function readPdf(filePath) {
  const script = 'import sys; from pypdf import PdfReader; r=PdfReader(sys.argv[1]); print("\\n".join((p.extract_text() or "") for p in r.pages))';
  const result = spawnSync(python, ['-c', script, filePath], { encoding: 'utf8', timeout: 20000, maxBuffer: 2_000_000, windowsHide: true });
  if (result.error) throw new Error(`Не удалось запустить ${python}: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || 'Не удалось прочитать PDF').trim().slice(0, 500));
  return result.stdout.trim().slice(0, 12000);
}

function fieldFromPdf(text, labels) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]{2,80})\s*[:—-]\s*(.+?)\s*$/);
    if (match && labels.some(label => match[1].toLocaleLowerCase('ru-RU').includes(label))) return match[2].trim();
  }
  return '';
}

async function downloadFiles(message) {
  const result = [];
  let pdfText = '';
  for (const item of attachments(message)) {
    if (item.file.file_size && item.file.file_size > 20 * 1024 * 1024) throw new Error('Файл больше ограничения Telegram в 20 МБ');
    const info = await telegram('getFile', { file_id: item.file.file_id });
    if (!info.file_path) throw new Error('Telegram не вернул путь к файлу');
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
    if (!response.ok) throw new Error('Не удалось скачать файл из Telegram');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error('Файл больше ограничения Telegram в 20 МБ');
    const extension = path.extname(item.name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 9) || path.extname(info.file_path) || '.bin';
    const id = `${crypto.randomUUID()}${extension}`;
    const filePath = path.join(filesDir, id);
    fs.writeFileSync(filePath, bytes, { flag: 'wx' });
    result.push({ id, name: item.name.slice(0, 180) });
    if (/\.pdf$/i.test(item.name)) {
      try { pdfText = readPdf(filePath); }
      catch (error) { console.error('PDF скачан, но текст не извлечён:', error.message); }
    }
  }
  return { documents: result, pdfText };
}

async function transcribeAudio(document) {
  if (!config.transcriptionApiKey || !document?.id) return '';
  const filePath = path.join(filesDir, document.id);
  const bytes = fs.readFileSync(filePath);
  const body = new FormData();
  body.append('model', config.transcriptionModel);
  body.append('language', 'ru');
  body.append('file', new Blob([bytes], { type: document.name.endsWith('.oga') ? 'audio/ogg' : 'audio/mpeg' }), document.name);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${config.transcriptionApiKey}` }, body
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Ошибка распознавания аудио (${response.status})`);
  return String(result.text || '').trim().slice(0, 4000);
}

function sourceLink(message) {
  const chat = String(message.chat.id);
  if (!chat.startsWith('-100')) return '';
  const base = `https://t.me/c/${chat.slice(4)}/${message.message_id}`;
  return message.message_thread_id ? `${base}?thread=${message.message_thread_id}` : base;
}

function forwardedFrom(message) {
  const origin = message.forward_origin;
  if (!origin) {
    if (message.forward_from_chat) return message.forward_from_chat.title || message.forward_from_chat.username || 'Telegram-чат';
    if (message.forward_from) return [message.forward_from.first_name, message.forward_from.last_name].filter(Boolean).join(' ');
    return '';
  }
  if (origin.type === 'user') return [origin.sender_user?.first_name, origin.sender_user?.last_name].filter(Boolean).join(' ');
  if (origin.type === 'hidden_user') return origin.sender_user_name || 'скрытый автор';
  if (origin.type === 'chat') return origin.sender_chat?.title || 'группа Telegram';
  if (origin.type === 'channel') return origin.chat?.title || origin.chat?.username || 'канал Telegram';
  return 'Telegram';
}

function isForwardedMessage(message) {
  return Boolean(message.forward_origin || message.forward_from || message.forward_from_chat || message.forward_sender_name);
}

function phoneFrom(text, filename) {
  return extractPhone(text) || extractPhone(filename);
}

function draftFrom(message, downloaded) {
  const text = messageText(message);
  const attachment = attachments(message)[0];
  const filename = attachment?.name || '';
  const fileFields = parseFilename(filename);
  const phone = phoneFrom(text, filename) || extractPhone(downloaded.pdfText);
  const captionLines = text.split(/\r?\n/).map(removePhones).filter(line => line && !/^заявка\b/i.test(line));
  const pdfBusiness = fieldFromPdf(downloaded.pdfText, ['название организации', 'наименование организации', 'название компании', 'название предприятия', 'наименование предприятия', 'название бизнеса']);
  const pdfContact = fieldFromPdf(downloaded.pdfText, ['контактное лицо', 'фио заявителя', 'фио', 'предприниматель']);
  const pdfEmail = downloaded.pdfText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const topicCategory = topicMap[String(message.message_thread_id)] || '';
  const pdfCategory = fieldFromPdf(downloaded.pdfText, ['рубрика', 'категория', 'сфера деятельности']);
  const category = topicCategory || pdfCategory || fileFields.category;
  const business = (pdfBusiness || fileFields.business || captionLines[0] || `Заявка из Telegram ${message.message_id}`).slice(0, 160);
  const contact = (pdfContact || captionLines[0] || '').slice(0, 160);
  const author = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');
  const forwardedAuthor = forwardedFrom(message);
  const forwardedDate = message.forward_origin?.date || message.forward_date;
  const forwardedNote = forwardedAuthor
    ? `Переслано из: ${forwardedAuthor}${forwardedDate ? ` · ${new Date(forwardedDate * 1000).toLocaleString('ru-RU')}` : ''}`
    : '';
  const source = sourceLink(message);
  const description = [forwardedNote, text.trim(), downloaded.pdfText ? `Поля PDF:\n${downloaded.pdfText}` : ''].filter(Boolean).join('\n\n');
  return {
    business, category, contact, phone, email: pdfEmail,
    source: message.chat.type === 'private' ? 'Telegram · переслано боту' : category ? `Telegram · ${category}` : 'Telegram-группа',
    notes: [forwardedNote, text.trim() || 'Заявка с вложением из Telegram.'].filter(Boolean).join('\n\n'), pdfText: downloaded.pdfText,
    documents: downloaded.documents, stage: 'Новая',
    externalId: `telegram:${message.chat.id}:${message.message_id}`,
    telegramMessage: { chatId: message.chat.id, messageId: message.message_id, threadId: message.message_thread_id || 0, link: source, date: new Date((message.date || Date.now() / 1000) * 1000).toISOString(), author },
    replyToMessageId: message.reply_to_message?.message_id,
    appendNote: description
  };
}

function statusKeyboard(id) {
  return [
    [{ text: 'На связи', callback_data: `st:${id}:1` }, { text: 'Материалы', callback_data: `st:${id}:2` }],
    [{ text: 'В редакции', callback_data: `st:${id}:3` }, { text: 'Опубликована', callback_data: `st:${id}:4` }],
    [{ text: 'Закрыта', callback_data: `st:${id}:5` }]
  ];
}

async function stagePrompt(chatId, threadId, application) {
  await send(chatId, `Управление заявкой «${application.business}» · ${application.stage}\n${application.phone || 'Телефон не найден'}`, {
    message_thread_id: threadId || undefined,
    reply_markup: { inline_keyboard: statusKeyboard(application.id).concat([[{ text: 'Добавить заметку / голос', callback_data: `vn:${application.id}` }]]) }
  });
}

async function beginNote(query, applicationId) {
  const list = await crm();
  const application = list.applications.find(item => item.id === applicationId);
  if (!application) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Заявка не найдена.' });
  sessions[String(query.from.id)] = { mode: 'note', applicationId, applicationName: application.business };
  persistSessions();
  await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Отправьте текст или голосовое сообщение.' });
  return send(query.message.chat.id, `Пришлите текстовую или голосовую заметку к заявке «${application.business}».`, { reply_markup: { force_reply: true, input_field_placeholder: 'Текст или голосовое сообщение' } });
}

async function saveNote(message, session) {
  let downloaded = { documents: [], pdfText: '' };
  let note = messageText(message).trim();
  const origin = forwardedFrom(message);
  if (origin) note = [`Переслано из: ${origin}`, note].filter(Boolean).join('\n');
  if (attachments(message).length) {
    downloaded = await downloadFiles(message);
    if (message.voice || message.audio) {
      try { note = await transcribeAudio(downloaded.documents[0]); }
      catch (error) { console.error('Голос сохранён без расшифровки:', error.message); }
      note = note ? `Голосовая заметка: ${note}` : 'Голосовая заметка сохранена как аудиофайл.';
    }
  }
  const list = await crm();
  const application = list.applications.find(item => item.id === session.applicationId);
  if (!application) throw new Error('Заявка не найдена.');
  const saved = await crm('POST', {
    ...application, stage: application.stage, documents: [...(application.documents || []), ...downloaded.documents],
    externalId: `telegram-note:${message.chat.id}:${message.message_id}`,
    appendNote: `${new Date((message.date || Date.now() / 1000) * 1000).toLocaleString('ru-RU')} · ${note || 'Заметка без текста'}${downloaded.documents.length ? ` · файл: ${downloaded.documents.map(file => file.name).join(', ')}` : ''}`
  });
  delete sessions[String(message.from.id)]; persistSessions();
  return send(message.chat.id, `Заметка добавлена к «${saved.business}».${downloaded.documents.length ? ` Файл: ${downloaded.documents[0].name}.` : ''}${(message.voice || message.audio) && !note.startsWith('Голосовая заметка:') ? ' Для расшифровки настройте OPENAI_API_KEY.' : ''}`);
}

async function createReview(message, downloaded) {
  const parsed = draftFrom(message, downloaded);
  if (Object.values(pending).some(item => item.parsed.externalId === parsed.externalId)) return;
  const id = crypto.randomUUID();
  let matches = [];
  if (parsed.phone) {
    try {
      const result = await crm();
      const key = parsed.phone.replace(/\D/g, '').slice(-10);
      matches = result.applications.filter(item => item.phone.replace(/\D/g, '').slice(-10) === key).slice(0, 3);
    } catch (error) { console.error('Не удалось проверить дубликаты:', error.message); }
  }
  pending[id] = { parsed, chatId: message.chat.id, threadId: message.message_thread_id || 0, documents: parsed.documents, matches: matches.map(item => item.id) };
  persistPending();
  await showReview(message.chat.id, message.message_thread_id || 0, message.message_id, id);
}

async function showReview(chatId, threadId, replyTo, draftId) {
  const draft = pending[draftId];
  if (!draft) return;
  const { parsed } = draft;
  const fileNames = draft.documents.map(doc => doc.name).join(', ') || 'нет';
  const matches = draft.matches || [];
  const list = matches.length ? await crm() : { applications: [] };
  const byId = new Map(list.applications.map(item => [item.id, item]));
  const summary = `Проверьте заявку\nБизнес: ${parsed.business}\nРубрика: ${parsed.category || 'не определена'}\nКонтакт: ${parsed.contact || 'не определён'}\nТелефон: ${parsed.phone || 'не найден'}\nПочта: ${parsed.email || 'не найдена'}\nФайлы: ${fileNames}${matches.length ? `\n\nВозможный дубль: ${matches.map(id => byId.get(id)?.business).filter(Boolean).join(', ')}` : ''}`;
  const keyboard = [[{ text: 'Изменить поля', callback_data: `rv:${draftId}:e` }, { text: 'Добавить как новую', callback_data: `rv:${draftId}:n` }]];
  for (const id of matches) {
    const item = byId.get(id);
    if (item) keyboard.push([{ text: `Добавить материалы · ${item.business}`.slice(0, 60), callback_data: `at:${draftId}:${matches.indexOf(id)}` }]);
  }
  keyboard.push([{ text: 'Пропустить', callback_data: `rv:${draftId}:x` }]);
  await send(chatId, summary, {
    message_thread_id: threadId || undefined,
    reply_to_message_id: replyTo || undefined,
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function editDraftMenu(query, draftId) {
  const draft = pending[draftId];
  if (!draft) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Черновик уже обработан.' });
  const fields = [['business', 'Название бизнеса'], ['category', 'Рубрика'], ['contact', 'Контакт'], ['phone', 'Телефон'], ['email', 'Почта']];
  const keyboard = fields.map(([key, label]) => [{ text: label, callback_data: `ed:${draftId}:${key}` }]);
  keyboard.push([{ text: 'Назад к карточке', callback_data: `rv:${draftId}:b` }]);
  await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Выберите поле для изменения.' });
  await send(query.message.chat.id, `Что исправить в «${draft.parsed.business}»?`, { reply_markup: { inline_keyboard: keyboard } });
}

async function requestDraftField(query, draftId, field) {
  const draft = pending[draftId];
  if (!draft || !['business', 'category', 'contact', 'phone', 'email'].includes(field)) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Черновик или поле не найдены.' });
  draft.awaitingField = field;
  draft.awaitingUserId = String(query.from.id);
  persistPending();
  await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Напишите новое значение.' });
  const labels = { business: 'название бизнеса', category: 'рубрику', contact: 'контактное лицо', phone: 'телефон', email: 'почту' };
  return send(query.message.chat.id, `Отправьте ${labels[field]} одним сообщением.`, { reply_markup: { force_reply: true, input_field_placeholder: labels[field] } });
}

function isLeadMessage(message) {
  const text = messageText(message);
  return attachments(message).length > 0 || Boolean(extractPhone(text)) || /заявк|контакт|телефон|номер/i.test(text);
}

async function approveDraft(query, draftId, action, matchIndex = -1) {
  const draft = pending[draftId];
  if (!draft) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Черновик уже обработан.' });
  if (action === 'x') {
    for (const doc of draft.documents) {
      if (/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/i.test(doc.id)) fs.rmSync(path.join(filesDir, doc.id), { force: true });
    }
    delete pending[draftId];
    persistPending();
    await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Заявка пропущена.' });
    return telegram('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `Пропущено: ${draft.parsed.business}` });
  }
  try {
    const list = action === 'a' && matchIndex >= 0 ? await crm() : null;
    const matchedId = action === 'a' ? draft.matches?.[matchIndex] : '';
    const matched = matchedId ? list?.applications.find(item => item.id === matchedId) : null;
    const application = await crm('POST', { ...draft.parsed, ...(matched ? { id: matched.id, stage: matched.stage } : {}), forceNew: action === 'n' });
    delete pending[draftId];
    persistPending();
    await telegram('answerCallbackQuery', { callback_query_id: query.id, text: matched ? 'Материалы добавлены к заявке.' : 'Добавлено в CRM.' });
    await telegram('editMessageText', {
      chat_id: query.message.chat.id, message_id: query.message.message_id,
      text: `${matched ? 'Материалы добавлены к заявке' : 'Добавлено в CRM'}\n${application.business} · ${application.category || 'Без рубрики'}\n${application.phone || 'Телефон не найден'} · ${application.stage}`,
      reply_markup: { inline_keyboard: statusKeyboard(application.id).concat([[{ text: 'Добавить заметку', callback_data: `vn:${application.id}` }], ...(application.telegramMessages?.[0]?.link ? [[{ text: 'Открыть сообщение', url: application.telegramMessages[0].link }]] : [])]) }
    });
  } catch (error) {
    await telegram('answerCallbackQuery', { callback_query_id: query.id, text: `Не сохранено: ${error.message.slice(0, 150)}`, show_alert: true });
  }
}

async function updateStage(query, applicationId, stageIndex) {
  const list = await crm();
  const current = list.applications.find(item => item.id === applicationId);
  if (!current || !stages[stageIndex]) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Заявка или статус не найдены.' });
  const updated = await crm('PUT', { ...current, stage: stages[stageIndex] });
  await telegram('answerCallbackQuery', { callback_query_id: query.id, text: `Статус: ${updated.stage}` });
  await telegram('editMessageText', {
    chat_id: query.message.chat.id, message_id: query.message.message_id,
    text: `Заявка «${updated.business}» · ${updated.stage}\n${updated.phone || 'Телефон не найден'}`,
    reply_markup: { inline_keyboard: statusKeyboard(updated.id) }
  });
}

async function handleCommand(message) {
  let text = messageText(message).trim();
  const thread = message.message_thread_id || 0;
  const senderId = String(message.from?.id || '');
  if (text === '📋 На сегодня' || text === 'На сегодня') text = '/today';
  if (text === '📊 Сводка' || text === 'Сводка') text = '/summary';
  if (text === '🔎 Найти заявку' || text === 'Найти заявку') text = '/find';
  if (text === '＋ Новая заявка' || text === 'Новая заявка') text = '/new';
  if (/^\/id(?:@\w+)?\b/i.test(text)) {
    if (message.chat.type === 'private') return send(message.chat.id, `Ваш Telegram ID: ${message.from?.id || 'не определён'}\nДобавьте его в .env в строку TELEGRAM_ALLOWED_USER_IDS, затем перезапустите бота. После этого пересылайте сюда сообщения с заявками.`, { reply_to_message_id: message.message_id });
    return send(message.chat.id, `ID группы: ${message.chat.id}\nID темы: ${thread || 'основная тема'}\nTELEGRAM_TOPIC_MAP: {"${thread}":"Название рубрики"}`, { message_thread_id: thread || undefined, reply_to_message_id: message.message_id });
  }
  if (/^\/(?:start|menu|help)(?:@\w+)?(?:\s|$)/i.test(text)) return sendHome(message.chat.id, message.from);
  if (/^\/new(?:@\w+)?\b/i.test(text)) {
    if (!config.telegramWebappUrl) return send(message.chat.id, 'Открой CRM в браузере, чтобы создать карточку. Кнопка Mini App появится после настройки TELEGRAM_WEBAPP_URL с HTTPS-адресом.');
    return send(message.chat.id, 'Создай новую карточку прямо в CRM:', { reply_markup: { inline_keyboard: [[{ text: '＋ Новая заявка в CRM', web_app: { url: config.telegramWebappUrl.replace(/\/$/, '') + '/?new=1' } }]] } });
  }
  if (/^\/today(?:@\w+)?\b/i.test(text)) {
    const { applications } = await crm();
    const today = new Date().toLocaleDateString('sv-SE');
    const items = applications.filter(item => item.deadline && item.deadline <= today && !['Опубликована', 'Закрыта'].includes(item.stage)).slice(0, 20);
    if (!items.length) return send(message.chat.id, 'Просроченных и назначенных на сегодня контактов нет.', { message_thread_id: thread || undefined });
    for (const item of items) await stagePrompt(message.chat.id, thread, item);
    return;
  }
  if (/^\/summary(?:@\w+)?\b/i.test(text)) {
    const { applications } = await crm();
    const today = new Date().toLocaleDateString('sv-SE');
    const due = applications.filter(item => item.deadline && item.deadline <= today && !['Опубликована', 'Закрыта'].includes(item.stage)).length;
    const active = applications.filter(item => !['Новая', 'Опубликована', 'Закрыта'].includes(item.stage)).length;
    return send(message.chat.id, `Сводка CRM\nВсего заявок: ${applications.length}\nВ работе: ${active}\nСвязаться сегодня или раньше: ${due}\nОпубликовано: ${applications.filter(item => item.stage === 'Опубликована').length}`);
  }
  if (/^\/find(?:@\w+)?\s+/i.test(text)) {
    const query = text.replace(/^\/find(?:@\w+)?\s+/i, '').toLowerCase();
    const digits = query.replace(/\D/g, '').slice(-10);
    const { applications } = await crm();
    const items = applications.filter(item => item.business.toLowerCase().includes(query) || (digits.length >= 5 && item.phone.replace(/\D/g, '').endsWith(digits))).slice(0, 8);
    if (!items.length) return send(message.chat.id, 'Заявки не найдены.', { message_thread_id: thread || undefined });
    for (const item of items) await stagePrompt(message.chat.id, thread, item);
    return;
  }
  if (/^\/find(?:@\w+)?$/i.test(text)) {
    sessions[senderId] = { mode: 'search' }; persistSessions();
    return send(message.chat.id, 'Напишите название бизнеса или телефон для поиска.', { reply_markup: { force_reply: true, input_field_placeholder: 'Название или телефон' } });
  }
  if (/^\/note(?:@\w+)?\s+/i.test(text)) {
    const query = text.replace(/^\/note(?:@\w+)?\s+/i, '').trim().toLowerCase();
    const digits = query.replace(/\D/g, '').slice(-10);
    const { applications } = await crm();
    const items = applications.filter(item => item.business.toLowerCase().includes(query) || (digits.length >= 5 && item.phone.replace(/\D/g, '').endsWith(digits))).slice(0, 5);
    if (!items.length) return send(message.chat.id, 'Заявка не найдена. Формат: /note телефон или название.');
    for (const item of items) await stagePrompt(message.chat.id, thread, item);
    return;
  }
  if (/^\/status(?:@\w+)?\s+/i.test(text)) {
    const query = text.replace(/^\/status(?:@\w+)?\s+/i, '').toLowerCase();
    const { applications } = await crm();
    const item = applications.find(application => application.id === query) || applications.find(application => application.phone.replace(/\D/g, '').endsWith(query.replace(/\D/g, '').slice(-10)));
    if (!item) return send(message.chat.id, 'Укажите телефон или ID заявки после команды /status.', { message_thread_id: thread || undefined });
    return stagePrompt(message.chat.id, thread, item);
  }
  if (/^\/date(?:@\w+)?\s+/i.test(text)) {
    const [phoneText, date] = text.replace(/^\/date(?:@\w+)?\s+/i, '').trim().split(/\s+/);
    const digits = (phoneText || '').replace(/\D/g, '').slice(-10);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && !Number.isNaN(Date.parse(date)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
    if (digits.length < 10 || !validDate) return send(message.chat.id, 'Формат: /date телефон ГГГГ-ММ-ДД', { message_thread_id: thread || undefined });
    const { applications } = await crm();
    const item = applications.find(application => application.phone.replace(/\D/g, '').endsWith(digits));
    if (!item) return send(message.chat.id, 'Заявка с таким телефоном не найдена.', { message_thread_id: thread || undefined });
    const updated = await crm('PUT', { ...item, deadline: date });
    return send(message.chat.id, `Следующий контакт назначен: ${updated.business} · ${date}`, { message_thread_id: thread || undefined });
  }
  return false;
}

function homeKeyboard() {
  const rows = [
    [{ text: '📋 На сегодня' }, { text: '📊 Сводка' }],
    [{ text: '🔎 Найти заявку' }, { text: '＋ Новая заявка' }]
  ];
  if (config.telegramWebappUrl) rows.push([{ text: 'Открыть CRM', web_app: { url: config.telegramWebappUrl } }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Перешли заявку или выбери действие' };
}

async function sendHome(chatId, user) {
  if (user?.id && !allowedUserIds.has(String(user.id))) return send(chatId, `Чтобы открыть личные функции, добавь свой ID ${user.id} в TELEGRAM_ALLOWED_USER_IDS в .env и перезапусти бота.`);
  return send(chatId, 'CRM «ВИЗИТ» готова. Можно переслать сюда заявку, PDF или отправить голосовую заметку к выбранной карточке.', { reply_markup: homeKeyboard() });
}

function zonedDateTime(date = new Date()) {
  return {
    date: date.toLocaleDateString('sv-SE', { timeZone: config.timeZone }),
    time: date.toLocaleTimeString('en-GB', { timeZone: config.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  };
}

async function sendDailyDigest() {
  if (!allowedUserIds.size) return;
  const { date, time } = zonedDateTime();
  if (time !== config.digestTime || scheduleState.lastDigestDate === date) return;
  const { applications } = await crm();
  const due = applications.filter(item => item.deadline && item.deadline <= date && !['Опубликована', 'Закрыта'].includes(item.stage));
  const body = due.length
    ? `План на сегодня · ${date}\n${due.slice(0, 25).map((item, index) => `${index + 1}. ${item.business} · ${item.phone || 'без телефона'} · ${item.stage}${item.deadline < date ? ' · просрочено' : ''}`).join('\n')}${due.length > 25 ? `\nИ ещё ${due.length - 25} заявок` : ''}`
    : `План на сегодня · ${date}\nЗаявок с наступившим сроком нет.`;
  for (const userId of allowedUserIds) await send(userId, body, config.telegramWebappUrl ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть CRM', web_app: { url: config.telegramWebappUrl } }]] } } : {});
  scheduleState.lastDigestDate = date; persistSchedule();
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const query = update.callback_query;
    const chatType = query.message?.chat?.type;
    if (chatType === 'private' && !allowedUserIds.has(String(query.from?.id || ''))) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Этот Telegram ID не разрешён для CRM.', show_alert: true });
    if (chatType !== 'private' && String(query.message?.chat?.id) !== allowedChat) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Действие недоступно в этом чате.', show_alert: true });
    const review = query.data?.match(/^rv:([a-f0-9-]{36}):(x|n|e|b)$/i);
    const attach = query.data?.match(/^at:([a-f0-9-]{36}):(\d)$/i);
    const edit = query.data?.match(/^ed:([a-f0-9-]{36}):(business|category|contact|phone|email)$/i);
    const stage = query.data?.match(/^st:([a-f0-9-]{36}):(\d)$/i);
    const note = query.data?.match(/^vn:([a-f0-9-]{36})$/i);
    if (review && review[2] === 'e') return editDraftMenu(query, review[1]);
    if (review && review[2] === 'b') return showReview(query.message.chat.id, query.message.message_thread_id || 0, undefined, review[1]);
    if (review && ['n', 'x'].includes(review[2])) return approveDraft(query, review[1], review[2]);
    if (attach) return approveDraft(query, attach[1], 'a', Number(attach[2]));
    if (edit) return requestDraftField(query, edit[1], edit[2]);
    if (note) return beginNote(query, note[1]);
    if (stage) return updateStage(query, stage[1], Number(stage[2]));
    return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Неизвестное действие.' });
  }
  const message = update.message;
  if (!message) return;
  const privateChat = message.chat.type === 'private';
  const userId = String(message.from?.id || '');
  const isIdCommand = /^\/id(?:@\w+)?\b/i.test(messageText(message).trim());
  if (privateChat && !isIdCommand && !allowedUserIds.has(userId)) {
    return send(message.chat.id, 'Для личных функций выполни /id, добавь свой ID в TELEGRAM_ALLOWED_USER_IDS в .env и перезапусти бота.');
  }
  if (message.text && await handleCommand(message)) return;
  const activeSession = privateChat ? sessions[userId] : null;
  if (activeSession?.mode === 'note') return saveNote(message, activeSession);
  if (activeSession?.mode === 'search' && message.text && !message.text.startsWith('/')) {
    delete sessions[userId]; persistSessions();
    const query = message.text.trim().toLowerCase();
    const digits = query.replace(/\D/g, '').slice(-10);
    const { applications } = await crm();
    const items = applications.filter(item => item.business.toLowerCase().includes(query) || (digits.length >= 5 && item.phone.replace(/\D/g, '').endsWith(digits))).slice(0, 8);
    if (!items.length) return send(message.chat.id, 'Заявки не найдены. Запусти поиск ещё раз кнопкой «🔎 Найти заявку».');
    for (const item of items) await stagePrompt(message.chat.id, 0, item);
    return;
  }
  if (privateChat && message.text && !isForwardedMessage(message)) {
    const waiting = Object.entries(pending).find(([, draft]) => draft.awaitingUserId === userId && draft.awaitingField);
    if (waiting) {
      const [draftId, draft] = waiting;
      const field = draft.awaitingField;
      draft.parsed[field] = message.text.trim().slice(0, field === 'business' || field === 'contact' ? 160 : field === 'email' ? 180 : 100);
      delete draft.awaitingField; delete draft.awaitingUserId;
      persistPending();
      return showReview(message.chat.id, 0, undefined, draftId);
    }
  }
  const privateForward = message.chat.type === 'private' && isForwardedMessage(message);
  if (privateForward) {
    // Private forwarding is limited to TELEGRAM_ALLOWED_USER_IDS above.
  } else if (!allowedChat || String(message.chat.id) !== allowedChat || !isLeadMessage(message)) return;
  const downloaded = await downloadFiles(message);
  await createReview(message, downloaded);
}

async function run() {
  const bot = await telegram('getMe');
  await telegram('setMyCommands', { commands: [
    { command: 'id', description: 'Показать ID группы и темы' },
    { command: 'today', description: 'Контакты на сегодня и просроченные' },
    { command: 'find', description: 'Найти заявку по телефону или бизнесу' },
    { command: 'status', description: 'Изменить статус заявки' },
    { command: 'date', description: 'Назначить следующий контакт' }
  ] });
  console.log(`Бот @${bot.username} запущен. Подключённая группа: ${allowedChat || 'не настроена'}`);
  while (true) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        await handleUpdate(update);
        offset = update.update_id + 1;
        fs.writeFileSync(offsetPath, JSON.stringify({ offset }));
      }
    } catch (error) {
      console.error('Связь с Telegram или CRM прервана:', error.message);
      await wait(5000);
    }
  }
}

run().catch(error => { console.error(error.message); process.exit(1); });
