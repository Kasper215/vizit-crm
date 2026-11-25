const $ = selector => document.querySelector(selector);
const apiRoot = '/api';
const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';
let sessionToken = sessionStorage.getItem('vizit-crm-session') || '';
const state = { applications: [], stages: [], view: 'list', dueOnly: false, selected: null, signature: '' };
const form = $('#editor');
const dialog = $('#editorDialog');
const fmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });

if (tg) {
  tg.ready(); tg.expand();
  try { tg.setHeaderColor('#f5f1e8'); tg.setBackgroundColor('#f5f1e8'); } catch {}
  const user = tg.initDataUnsafe?.user;
  if (user?.first_name) $('#userName').textContent = user.first_name;
}

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

async function openSession() {
  if (!initData || sessionToken) return;
  const response = await fetch('/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось подтвердить аккаунт Telegram');
  sessionToken = data.token;
  sessionStorage.setItem('vizit-crm-session', sessionToken);
}

async function request(path = '/applications', options = {}, retried = false) {
  await openSession();
  const response = await fetch(apiRoot + path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}), ...options.headers }
  });
  const data = await response.json();
  if (response.status === 401 && sessionToken && !retried) {
    sessionToken = ''; sessionStorage.removeItem('vizit-crm-session');
    return request(path, options, true);
  }
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос');
  return data;
}

function today() { return new Date().toLocaleDateString('sv-SE'); }
function isDue(item) { return item.deadline && item.deadline <= today() && !['Опубликована', 'Закрыта'].includes(item.stage); }

function filtered() {
  const q = $('#search').value.trim().toLocaleLowerCase('ru-RU').replace(/^@/, '');
  return state.applications.filter(item => (!$('#stageFilter').value || item.stage === $('#stageFilter').value)
    && (!state.dueOnly || isDue(item))
    && (!q || [item.business, item.category, item.contact, item.phone, item.email, item.instagram, item.pdfText, item.notes].some(value => String(value || '').toLocaleLowerCase('ru-RU').includes(q))));
}

function renderMetrics() {
  const root = $('#metrics'); root.replaceChildren();
  const values = [
    ['Заявки', state.applications.length, false],
    ['В работе', state.applications.filter(item => !['Новая', 'Опубликована', 'Закрыта'].includes(item.stage)).length, false],
    ['Связаться', state.applications.filter(isDue).length, true],
    ['Опубликовано', state.applications.filter(item => item.stage === 'Опубликована').length, false]
  ];
  for (const [label, count, attention] of values) {
    const card = node('article', undefined, `metric${attention && count ? ' attention' : ''}`);
    card.append(node('span', label), node('strong', count)); root.append(card);
  }
}

function openRecord(item = null) {
  state.selected = item?.id || null;
  form.reset(); $('#formError').textContent = '';
  $('#dialogTitle').textContent = item ? 'Заявка' : 'Новая заявка';
  for (const field of form.querySelectorAll('[name]')) field.value = item?.[field.name] ?? (field.name === 'stage' ? state.stages[0] : '');
  const docs = $('#documents'); docs.replaceChildren();
  if (item?.documents?.length) {
    docs.append(node('h3', 'Файлы'));
    for (const file of item.documents) { const a = node('a', `↳ ${file.name}`); a.href = `/api/files/${encodeURIComponent(file.id)}`; a.target = '_blank'; docs.append(a); }
  }
  const sources = $('#sourceLinks'); sources.replaceChildren();
  const links = (item?.telegramMessages || []).filter(message => message.link);
  if (links.length) {
    sources.append(node('h3', 'Источники Telegram'));
    for (const message of links) { const a = node('a', `↗ ${message.author || 'Открыть сообщение'} · ${fmt.format(new Date(message.date))}`); a.href = message.link; a.target = '_blank'; a.rel = 'noreferrer'; sources.append(a); }
  }
  $('#pdfText').textContent = item?.pdfText || 'Для этой заявки нет текста PDF.';
  $('#pdfDetails').open = false;
  const history = $('#history'); history.replaceChildren();
  if (item?.history?.length) {
    history.append(node('h3', 'История этапов'));
    for (const event of item.history) history.append(node('p', `${fmt.format(new Date(event.date))} · ${event.stage}`));
  }
  dialog.showModal();
}

function makeRecordCard(item) {
  const card = node('article', undefined, 'record-card');
  card.setAttribute('role', 'button'); card.tabIndex = 0;
  const main = node('div', undefined, 'record-main');
  main.append(node('div', item.business, 'record-name'), node('div', [item.category, item.contact].filter(Boolean).join(' · ') || 'Контакт не указан', 'record-sub'));
  const badge = node('span', item.stage, 'stage'); badge.dataset.stage = item.stage;
  const contact = node('div', item.phone || item.email || 'Контакт не указан', 'record-info');
  const deadline = node('div', item.deadline ? `Связаться · ${item.deadline}` : 'Без срока', `record-info${isDue(item) ? ' due' : ''}`);
  card.append(main, badge, contact, deadline);
  const open = () => openRecord(item);
  card.addEventListener('click', open); card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return card;
}

function renderList(items, container) {
  const list = node('div', undefined, 'record-list');
  for (const item of items) list.append(makeRecordCard(item));
  container.append(list);
}

function renderBoard(items, container) {
  const board = node('div', undefined, 'board');
  for (const stage of state.stages.filter(value => !$('#stageFilter').value || value === $('#stageFilter').value)) {
    const column = node('section', undefined, 'board-column');
    const rows = items.filter(item => item.stage === stage);
    column.append(node('h3', `${stage} · ${rows.length}`));
    for (const item of rows) {
      const card = node('button', undefined, 'board-card');
      card.append(node('span', item.business), node('small', [item.contact, item.phone].filter(Boolean).join(' · ') || item.category || 'Без контакта'));
      card.onclick = () => openRecord(item); column.append(card);
    }
    board.append(column);
  }
  container.append(board);
}

function render() {
  renderMetrics();
  const root = $('#results'); root.replaceChildren();
  const items = filtered();
  if (!items.length) {
    const empty = node('div', undefined, 'empty');
    empty.append(node('strong', state.dueOnly ? 'На сегодня всё' : (state.applications.length ? 'Ничего не найдено' : 'Пока нет заявок')),
      node('p', state.dueOnly ? 'Новых напоминаний на сегодня нет.' : (state.applications.length ? 'Попробуйте изменить поиск или фильтр.' : 'Создайте первую карточку или пересылайте заявки боту.')));
    root.append(empty); return;
  }
  state.view === 'board' ? renderBoard(items, root) : renderList(items, root);
}

async function load() {
  const data = await request();
  state.applications = data.applications; state.stages = data.stages;
  state.signature = data.applications.map(item => `${item.id}:${item.updatedAt}`).join('|');
  const filter = $('#stageFilter'), stage = form.elements.stage;
  const oldFilter = filter.value;
  filter.replaceChildren(new Option('Все этапы', ''));
  stage.replaceChildren();
  for (const value of state.stages) { filter.add(new Option(value)); stage.add(new Option(value)); }
  filter.value = oldFilter;
  render();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]'); submit.disabled = true; $('#formError').textContent = '';
  try {
    const payload = { ...Object.fromEntries(new FormData(form)), id: state.selected };
    const saved = await request('/applications', { method: state.selected ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    dialog.close(); await load();
    state.selected = saved.id;
  } catch (error) { $('#formError').textContent = error.message; }
  finally { submit.disabled = false; }
});

$('#newApplication').onclick = () => openRecord();
$('#closeDialog').onclick = $('#cancelDialog').onclick = () => dialog.close();
$('#search').addEventListener('input', render);
$('#stageFilter').addEventListener('change', render);
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  state.view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(item => item.setAttribute('aria-selected', String(item.dataset.view === state.view)));
  document.querySelectorAll('.bottom-nav [data-view]').forEach(item => item.setAttribute('aria-current', item.dataset.view === state.view ? 'page' : 'false'));
  state.dueOnly = false; $('#pageTitle').textContent = state.view === 'board' ? 'Воронка' : 'Заявки'; render();
});
$('#dueNav').onclick = () => { state.dueOnly = !state.dueOnly; $('#pageTitle').textContent = state.dueOnly ? 'На сегодня' : 'Заявки'; state.view = 'list'; render(); };

async function init() {
  $('#notice').textContent = '';
  try {
    await load();
    const params = new URLSearchParams(location.search);
    if (params.get('new') === '1') openRecord();
  }
  catch (error) { $('#notice').textContent = error.message; }
}

init();
setInterval(async () => {
  if (dialog.open) return;
  try {
    const data = await request();
    const signature = data.applications.map(item => `${item.id}:${item.updatedAt}`).join('|');
    if (signature === state.signature) return;
    state.applications = data.applications; state.stages = data.stages; state.signature = signature; render();
  } catch {}
}, 12000);
