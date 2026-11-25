const get = selector => document.querySelector(selector);
const search = get('#search');
const filter = get('#filter');
const dialog = get('#card');
const form = get('#editor');
const format = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });
let applications = [];
let stages = [];
let view = 'list';
let selected = null;
let dataSignature = '';

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function visible() {
  const query = search.value.trim().toLowerCase().replace(/^@/, '');
  return applications.filter(item => (!filter.value || item.stage === filter.value)
    && [item.business, item.category, item.contact, item.phone, item.email, item.instagram, item.pdfText].some(value => String(value || '').toLowerCase().includes(query)));
}

function localToday() {
  return new Date().toLocaleDateString('sv-SE');
}

function due(item) {
  return Boolean(item.deadline && item.deadline <= localToday() && !['Опубликована', 'Закрыта'].includes(item.stage));
}

function openCard(item) {
  selected = item?.id ?? null;
  form.reset();
  get('#error').textContent = '';
  get('#cardTitle').textContent = item ? 'Карточка заявки' : 'Новая заявка';
  for (const field of form.querySelectorAll('[name]')) {
    field.value = item?.[field.name] ?? (field.name === 'stage' ? stages[0] : '');
  }
  const history = get('#history');
  history.replaceChildren();
  const documents = get('#documents');
  documents.replaceChildren();
  if (item?.documents?.length) {
    documents.append(element('h3', 'Документы и файлы'));
    for (const file of item.documents) {
      const link = element('a', file.name);
      link.href = '/api/files/' + encodeURIComponent(file.id);
      documents.append(link, element('br'));
    }
  }
  const sourceLinks = get('#sourceLinks');
  sourceLinks.replaceChildren();
  if (item?.telegramMessages?.length) {
    sourceLinks.append(element('h3', 'Сообщения Telegram'));
    for (const message of item.telegramMessages) {
      if (!message.link) continue;
      const link = element('a', `${message.author || 'Открыть сообщение'} · ${format.format(new Date(message.date))}`);
      link.href = message.link;
      link.target = '_blank';
      link.rel = 'noreferrer';
      sourceLinks.append(link, element('br'));
    }
  }
  const pdfText = get('#pdfText');
  pdfText.textContent = item?.pdfText || 'Для этой заявки PDF ещё не разбирался.';
  get('#pdfDetails').open = false;
  if (item?.history.length) {
    const details = element('details');
    details.append(element('summary', 'История статусов'));
    for (const event of item.history) details.append(element('p', format.format(new Date(event.date)) + ' · ' + event.stage));
    history.append(details);
  }
  dialog.showModal();
}

function recordButton(item) {
  const button = element('button', item.business, 'record');
  button.addEventListener('click', () => openCard(item));
  return button;
}

function render() {
  const metrics = get('#metrics');
  metrics.replaceChildren();
  const counts = [
    ['Всего заявок', applications.length],
    ['В работе', applications.filter(item => !['Новая', 'Закрыта', 'Опубликована'].includes(item.stage)).length],
    ['Связаться сегодня или раньше', applications.filter(due).length],
    ['Опубликовано', applications.filter(item => item.stage === 'Опубликована').length]
  ];
  for (const [label, count] of counts) {
    const box = element('article');
    box.append(element('span', label), element('strong', count));
    metrics.append(box);
  }
  const items = visible();
  const results = get('#results');
  results.replaceChildren();
  if (!items.length && view === 'list') {
    const empty = element('div', undefined, 'empty');
    empty.append(element('h2', applications.length ? 'Совпадений нет' : 'Заявок пока нет'),
      element('p', applications.length ? 'Попробуйте другой запрос или статус.' : 'Добавьте бизнес, с которым редакция планирует связаться.'));
    results.append(empty);
    return;
  }
  if (view === 'board') {
    const board = element('div', undefined, 'board');
    for (const stage of stages.filter(stage => !filter.value || filter.value === stage)) {
      const column = element('section');
      const rows = items.filter(item => item.stage === stage);
      column.append(element('h2', stage + ' · ' + rows.length));
      for (const item of rows) {
        const card = element('article');
        card.append(recordButton(item), element('p', item.category || item.contact || ''));
        if (item.deadline) card.append(element('small', item.deadline, due(item) ? 'due' : ''));
        column.append(card);
      }
      board.append(column);
    }
    results.append(board);
    return;
  }
  const table = element('table');
  const labels = ['Бизнес', 'Контакт', 'Телефон', 'Статус', 'Следующий контакт'];
  const head = table.createTHead().insertRow();
  for (const label of labels) head.append(element('th', label));
  const body = table.createTBody();
  for (const item of items) {
    const row = body.insertRow();
    row.insertCell().append(recordButton(item), element('small', item.category));
    row.insertCell().textContent = item.contact || item.instagram || '—';
    row.insertCell().textContent = item.phone || '—';
    row.insertCell().append(element('span', item.stage, 'badge'));
    row.insertCell().append(element('span', item.deadline || '—', due(item) ? 'due' : ''));
  }
  results.append(table);
}

async function request(options) {
  const response = await fetch('/api/applications', options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  get('#error').textContent = '';
  try {
    const saved = await request({
      method: selected ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), id: selected })
    });
    applications = [saved, ...applications.filter(item => item.id !== saved.id)];
    dialog.close();
    render();
  } catch (error) {
    get('#error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

get('#close').onclick = () => dialog.close();
get('#add').onclick = () => { if (stages.length) openCard(null); };
search.oninput = filter.onchange = render;
for (const button of document.querySelectorAll('[data-view]')) {
  button.onclick = () => {
    view = button.dataset.view;
    for (const tab of document.querySelectorAll('[data-view]')) tab.setAttribute('aria-pressed', tab === button);
    get('#title').textContent = view === 'board' ? 'Воронка заявок' : 'Заявки на размещение';
    render();
  };
}

get('#export').onclick = () => {
  const cell = value => {
    const safe = /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const rows = [['Бизнес', 'Рубрика', 'Контакт', 'Телефон', 'Почта', 'Instagram', 'Источник', 'Статус', 'Следующий контакт', 'Заметки'],
    ...visible().map(item => [item.business, item.category, item.contact, item.phone, item.email, item.instagram, item.source, item.stage, item.deadline, item.notes])];
  const file = new Blob(['\ufeff', rows.map(row => row.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = element('a');
  link.href = URL.createObjectURL(file);
  link.download = 'vizit-zayavki.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

try {
  ({ applications, stages } = await request());
  filter.add(new Option('Все статусы', ''));
  for (const stage of stages) {
    filter.add(new Option(stage));
    form.elements.stage.add(new Option(stage));
  }
  render();
} catch (error) {
  get('#notice').textContent = 'Не удалось загрузить CRM. ' + error.message;
}

function syncSignature(items) {
  return items.map(item => `${item.id}:${item.updatedAt}`).join('|');
}

dataSignature = syncSignature(applications);
setInterval(async () => {
  if (dialog.open) return;
  try {
    const data = await request();
    const signature = syncSignature(data.applications);
    if (signature === dataSignature) return;
    applications = data.applications; stages = data.stages; dataSignature = signature; render();
  } catch (error) {
    get('#notice').textContent = 'Связь с CRM временно потеряна. Повторное подключение выполняется автоматически.';
  }
}, 12000);
