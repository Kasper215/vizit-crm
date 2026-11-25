const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const repository = require('../repositories/applications');
const { verifyInitData, verifyServiceToken } = require('../security/telegram-auth');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const webSessions = new Map();
const miniSessions = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readJson(req, maxBytes = 12 * 1024 * 1024) {
  let raw = '';
  for await (const chunk of req.setEncoding('utf8')) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw Object.assign(new Error('Данные превышают допустимый размер'), { status: 413 });
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('Некорректные данные'), { status: 400 }); }
}

function authorized(req) {
  if (verifyServiceToken(req.headers.authorization, config.serviceToken)) return { id: 'telegram-bot', role: 'service' };
  const ip = req.socket.remoteAddress || '';
  if (config.nodeEnv !== 'production' && loopback.has(ip)) return { id: 'local-development', role: 'admin' };
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const session = miniSessions.get(bearer) || webSessions.get(bearer);
  if (session && session.expiresAt > Date.now()) return session.user;
  if (session) { miniSessions.delete(bearer); webSessions.delete(bearer); }
  const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('crm_session='));
  if (cookie) {
    const cookieToken = decodeURIComponent(cookie.slice('crm_session='.length));
    const cookieSession = webSessions.get(cookieToken);
    if (cookieSession && cookieSession.expiresAt > Date.now()) return cookieSession.user;
    if (cookieSession) webSessions.delete(cookieToken);
  }
  return null;
}

function publicBinding() {
  return !loopback.has(config.host);
}

function newSession(map, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  map.set(token, { user, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function serveFile(res, file) {
  if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Страница не найдена' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, app: 'vizit-crm' });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (publicBinding() && config.webPassword && !authorized(req)) return serveFile(res, path.join(config.root, 'miniapp', 'login.html'));
      return serveFile(res, path.join(config.root, 'index.html'));
    }
    if (req.method === 'GET' && url.pathname === '/app.js') return serveFile(res, path.join(config.root, 'app.js'));
    if (req.method === 'GET' && url.pathname === '/style.css') return serveFile(res, path.join(config.root, 'style.css'));
    if (req.method === 'GET' && url.pathname === '/login.js') return serveFile(res, path.join(config.root, 'miniapp', 'login.js'));
    if (req.method === 'GET' && url.pathname === '/login.css') return serveFile(res, path.join(config.root, 'miniapp', 'login.css'));
    if (req.method === 'GET' && (url.pathname === '/miniapp' || url.pathname.startsWith('/miniapp/'))) {
      const local = url.pathname === '/miniapp' ? 'index.html' : path.basename(url.pathname);
      if (!['index.html', 'app.js', 'style.css'].includes(local)) return sendJson(res, 404, { error: 'Страница не найдена' });
      return serveFile(res, path.join(config.root, 'miniapp', local));
    }
    if (req.method === 'POST' && url.pathname === '/api/session') {
      if (!config.telegramToken || !config.allowedUserIds.size) return sendJson(res, 503, { error: 'Настройте TELEGRAM_BOT_TOKEN и список разрешённых пользователей.' });
      const input = await readJson(req, 32_000);
      const user = verifyInitData(input.initData, config.telegramToken, config.allowedUserIds);
      if (!user) return sendJson(res, 401, { error: 'Сеанс Telegram истёк или пользователь не разрешён. Закройте и снова откройте Mini App.' });
      const token = newSession(miniSessions, user);
      return sendJson(res, 200, { token, expiresIn: SESSION_TTL });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!config.webPassword) return sendJson(res, 404, { error: 'Вход через браузер не настроен.' });
      const input = await readJson(req, 32_000);
      const supplied = Buffer.from(String(input.password || ''));
      const expected = Buffer.from(config.webPassword);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return sendJson(res, 401, { error: 'Неверный пароль.' });
      const token = newSession(webSessions, { id: 'web-admin', role: 'admin' });
      const secure = config.nodeEnv === 'production' ? '; Secure' : '';
      res.writeHead(204, { 'Set-Cookie': `crm_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      const actor = authorized(req);
      if (!actor) return sendJson(res, 401, { error: 'Откройте CRM из разрешённого Telegram-аккаунта или локального компьютера.' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
        return sendJson(res, 403, { error: 'Запрос с другого сайта запрещён.' });
      }
    }

    const fileMatch = url.pathname.match(/^\/api\/files\/([a-f0-9-]{36}\.[a-z0-9]{1,8})$/i);
    if (req.method === 'GET' && fileMatch) {
      const file = path.join(config.uploadsDir, fileMatch[1]);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Файл не найден.' });
      const ext = path.extname(file).toLowerCase();
      const type = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.oga': 'audio/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${path.basename(file)}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
      return fs.createReadStream(file).pipe(res);
    }

    if (url.pathname === '/api/applications') {
      if (req.method === 'GET') {
        const all = repository.list();
        const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('ru-RU');
        const stage = url.searchParams.get('stage') || '';
        const applications = all.filter(item => (!stage || item.stage === stage)
          && (!query || [item.business, item.category, item.contact, item.phone, item.email, item.instagram, item.pdfText, item.notes].some(value => String(value || '').toLocaleLowerCase('ru-RU').includes(query))));
        return sendJson(res, 200, { applications, stages: repository.stages });
      }
      if (!['POST', 'PUT'].includes(req.method)) return sendJson(res, 405, { error: 'Метод не поддерживается.' });
      const input = await readJson(req);
      const saved = repository.save(input, req.method);
      return sendJson(res, 200, saved);
    }
    const applicationMatch = url.pathname.match(/^\/api\/applications\/([a-f0-9-]{36})$/i);
    if (applicationMatch && req.method === 'GET') {
      const item = repository.get(applicationMatch[1]);
      return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: 'Заявка не найдена.' });
    }
    if (url.pathname === '/api/summary' && req.method === 'GET') {
      const applications = repository.list();
      const today = new Date().toLocaleDateString('sv-SE');
      return sendJson(res, 200, {
        total: applications.length,
        active: applications.filter(item => !['Новая', 'Опубликована', 'Закрыта'].includes(item.stage)).length,
        due: applications.filter(item => item.deadline && item.deadline <= today && !['Опубликована', 'Закрыта'].includes(item.stage)).length,
        published: applications.filter(item => item.stage === 'Опубликована').length
      });
    }
    return sendJson(res, 404, { error: 'Страница не найдена.' });
  } catch (error) {
    console.error(error);
    return sendJson(res, error.status || 500, { error: error.status ? error.message : 'Не удалось обработать запрос.' });
  }
});

function start() {
  if (publicBinding() && (!config.allowedUserIds.size || !config.serviceToken || !config.webPassword)) {
    throw new Error('Для внешнего HOST настройте TELEGRAM_ALLOWED_USER_IDS, CRM_API_TOKEN и CRM_WEB_PASSWORD.');
  }
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Порт занят. Укажите другой порт через переменную PORT.' : error.message);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => console.log(`CRM ВИЗИТ: http://${config.host}:${config.port}`));
}

module.exports = { server, start };
