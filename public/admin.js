const loginPanel = document.querySelector('#loginPanel');
const adminPanel = document.querySelector('#adminPanel');
const loginForm = document.querySelector('#loginForm');
const password = document.querySelector('#password');
const logout = document.querySelector('#logout');
const adminDisplayName = document.querySelector('#adminDisplayName');
const profileForm = document.querySelector('#profileForm');
const displayNameInput = document.querySelector('#displayNameInput');
const currentPasswordInput = document.querySelector('#currentPasswordInput');
const newPasswordInput = document.querySelector('#newPasswordInput');
const settingsForm = document.querySelector('#settingsForm');
const titleTextInput = document.querySelector('#titleTextInput');
const titleImageInput = document.querySelector('#titleImageInput');
const titleColorInput = document.querySelector('#titleColorInput');
const titleFontInput = document.querySelector('#titleFontInput');
const moderationInput = document.querySelector('#moderationInput');
const clearTitleImage = document.querySelector('#clearTitleImage');
const refresh = document.querySelector('#refresh');
const adminMagnets = document.querySelector('#adminMagnets');
const filterRow = document.querySelector('#filterRow');
const refreshLogs = document.querySelector('#refreshLogs');
const clearLogs = document.querySelector('#clearLogs');
const adminLogs = document.querySelector('#adminLogs');
const deleteAllMagnets = document.querySelector('#deleteAllMagnets');
const toast = document.querySelector('#toast');

let allMagnets = [];
let activeFilter = 'all';
let currentAdmin = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Ошибка запроса');
  }
  return data;
}

function setAuthed(admin) {
  loginPanel.hidden = admin;
  adminPanel.hidden = !admin;
}

function setAdminProfile(admin) {
  currentAdmin = admin;
  adminDisplayName.textContent = admin?.displayName || '';
  displayNameInput.value = admin?.displayName || '';
}

async function loadSettings() {
  const cfg = await request('/api/settings');
  titleTextInput.value = cfg.titleText || 'Наш холодильник';
  titleColorInput.value = cfg.titleColor || '#2a363b';
  titleFontInput.value = cfg.titleFont || 'classic';
  moderationInput.checked = Boolean(cfg.moderation);
}

function card(magnet) {
  const el = document.createElement('article');
  el.className = 'admin-card';

  const img = document.createElement('img');
  img.src = magnet.src;
  img.alt = magnet.originalName || 'Магнит';
  img.loading = 'lazy';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span>${magnet.status === 'pending' ? 'на модерации' : 'опубликован'}</span><span>${magnet.frameStyle || 'polaroid'} · ${magnet.frameColor || 'white'} · ♥ ${magnet.likes}</span>`;

  const caption = document.createElement('div');
  caption.className = 'admin-caption';
  caption.textContent = magnet.caption ? `“${magnet.caption}”` : 'Без подписи';

  const actions = document.createElement('div');
  actions.className = 'admin-actions';

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'secondary';
  approve.textContent = magnet.status === 'pending' ? 'Одобрить' : 'Скрыть';
  approve.addEventListener('click', async () => {
    try {
      await request(`/api/admin/magnets/${magnet.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: magnet.status === 'pending' ? 'approved' : 'pending' })
      });
      await loadMagnets();
    } catch (error) {
      showToast(error.message);
    }
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Удалить';
  remove.addEventListener('click', async () => {
    if (!confirm('Удалить магнит навсегда?')) return;
    try {
      await request(`/api/admin/magnets/${magnet.id}`, { method: 'DELETE' });
      await loadMagnets();
      showToast('Магнит удален');
    } catch (error) {
      showToast(error.message);
    }
  });

  actions.append(approve, remove);
  el.append(img, meta, caption, actions);
  return el;
}

async function loadMagnets() {
  allMagnets = await request('/api/magnets?all=1');
  let rows = [...allMagnets];
  if (activeFilter === 'pending') rows = rows.filter(magnet => magnet.status === 'pending');
  if (activeFilter === 'popular') rows.sort((a, b) => b.likes - a.likes);
  if (activeFilter === 'nocaption') rows = rows.filter(magnet => !magnet.caption);
  adminMagnets.replaceChildren(...rows.map(card));
  if (!rows.length) {
    adminMagnets.textContent = 'Магнитов пока нет.';
  }
}

async function loadLogs() {
  const rows = await request('/api/admin/logs');
  adminLogs.replaceChildren(...rows.map(row => {
    const el = document.createElement('div');
    el.className = 'log-row';
    const actor = row.adminName ? ` · ${row.adminName}` : '';
    const ip = row.ip ? ` · ${row.ip}` : '';
    const details = row.details && row.details !== '{}' ? ` · ${row.details}` : '';
    el.textContent = `${row.createdAt} · ${row.action}${actor}${ip}${details}`;
    return el;
  }));
  if (!rows.length) adminLogs.textContent = 'Журнал пока пуст.';
}

async function boot() {
  const me = await request('/api/admin/me');
  setAuthed(me.admin);
  if (me.admin) {
    setAdminProfile(me);
    await Promise.all([loadSettings(), loadMagnets(), loadLogs()]);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await request('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value })
    });
    password.value = '';
    setAuthed(true);
    setAdminProfile(result.admin);
    await Promise.all([loadSettings(), loadMagnets(), loadLogs()]);
  } catch (error) {
    showToast(error.message);
  }
});

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await request('/api/admin/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: displayNameInput.value,
        currentPassword: currentPasswordInput.value,
        newPassword: newPasswordInput.value
      })
    });
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    setAdminProfile(result.admin);
    await loadLogs();
    showToast('Профиль сохранен');
  } catch (error) {
    showToast(error.message);
  }
});

logout.addEventListener('click', async () => {
  await request('/api/admin/logout', { method: 'POST' });
  setAuthed(false);
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData();
  form.append('titleText', titleTextInput.value);
  form.append('titleColor', titleColorInput.value);
  form.append('titleFont', titleFontInput.value);
  form.append('moderation', String(moderationInput.checked));
  form.append('clearTitleImage', String(clearTitleImage.checked));
  if (titleImageInput.files[0]) {
    form.append('titleImage', titleImageInput.files[0]);
  }
  try {
    await request('/api/admin/settings', { method: 'PATCH', body: form });
    titleImageInput.value = '';
    clearTitleImage.checked = false;
    showToast('Настройки сохранены');
  } catch (error) {
    showToast(error.message);
  }
});

refresh.addEventListener('click', () => loadMagnets().catch(error => showToast(error.message)));
refreshLogs.addEventListener('click', () => loadLogs().catch(error => showToast(error.message)));
clearLogs.addEventListener('click', async () => {
  if (!confirm('Очистить журнал действий? Это действие нельзя отменить.')) return;
  const phrase = prompt('Для подтверждения введите: ОЧИСТИТЬ ЖУРНАЛ');
  if (phrase !== 'ОЧИСТИТЬ ЖУРНАЛ') {
    showToast('Очистка отменена');
    return;
  }
  try {
    const result = await request('/api/admin/logs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: phrase })
    });
    await loadLogs();
    showToast(`Журнал очищен: ${result.deleted}`);
  } catch (error) {
    showToast(error.message);
  }
});
deleteAllMagnets.addEventListener('click', async () => {
  if (!allMagnets.length) {
    showToast('Магнитов пока нет');
    return;
  }
  if (!confirm(`Удалить все магниты? Сейчас будет удалено: ${allMagnets.length}. Это действие нельзя отменить.`)) {
    return;
  }
  const phrase = prompt('Для подтверждения введите: УДАЛИТЬ ВСЕ');
  if (phrase !== 'УДАЛИТЬ ВСЕ') {
    showToast('Удаление отменено');
    return;
  }
  try {
    const result = await request('/api/admin/magnets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: phrase })
    });
    await Promise.all([loadMagnets(), loadLogs()]);
    showToast(`Удалено магнитов: ${result.count}`);
  } catch (error) {
    showToast(error.message);
  }
});
filterRow.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  activeFilter = button.dataset.filter;
  filterRow.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
  loadMagnets().catch(error => showToast(error.message));
});
boot().catch(() => setAuthed(false));
