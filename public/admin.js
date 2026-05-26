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
const uploadsClosedInput = document.querySelector('#uploadsClosedInput');
const magnetHoldersInput = document.querySelector('#magnetHoldersInput');
const clearTitleImage = document.querySelector('#clearTitleImage');
const storagePanel = document.querySelector('#storagePanel');
const storageText = document.querySelector('#storageText');
const fridgeStatus = document.querySelector('#fridgeStatus');
const refreshStorage = document.querySelector('#refreshStorage');
const closeFridge = document.querySelector('#closeFridge');
const openFridge = document.querySelector('#openFridge');
const createBackup = document.querySelector('#createBackup');
const backupSelect = document.querySelector('#backupSelect');
const restoreBackup = document.querySelector('#restoreBackup');
const refresh = document.querySelector('#refresh');
const adminMagnets = document.querySelector('#adminMagnets');
const filterRow = document.querySelector('#filterRow');
const refreshLogs = document.querySelector('#refreshLogs');
const clearLogs = document.querySelector('#clearLogs');
const confirmClearLogs = document.querySelector('#confirmClearLogs');
const adminLogs = document.querySelector('#adminLogs');
const deleteAllMagnets = document.querySelector('#deleteAllMagnets');
const toast = document.querySelector('#toast');

let allMagnets = [];
let activeFilter = 'all';
let currentAdmin = null;
let clearLogsArmed = false;
let storageWarned = false;

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
  uploadsClosedInput.checked = Boolean(cfg.uploadsClosed);
  magnetHoldersInput.checked = Boolean(cfg.magnetHolders);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

async function loadStorage() {
  const info = await request('/api/admin/storage');
  const closed = Boolean(info.uploadsClosed);
  storageText.textContent = `${formatBytes(info.memsBytes)} из 1.00 ГБ`;
  storagePanel.classList.toggle('warning', info.overLimit);
  fridgeStatus.textContent = closed ? 'Холодильник закрыт' : 'Холодильник открыт';
  fridgeStatus.classList.toggle('closed', closed);
  fridgeStatus.classList.toggle('open', !closed);
  uploadsClosedInput.checked = closed;
  if (info.overLimit && !storageWarned) {
    storageWarned = true;
    const clear = confirm('Папка mems больше 1 ГБ. Провести полную очистку холодильника от магнитов?');
    if (clear) {
      const phrase = prompt('Для подтверждения очистки введите: УДАЛИТЬ ВСЕ');
      if (phrase === 'УДАЛИТЬ ВСЕ') {
        await request('/api/admin/magnets', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: phrase })
        });
        await Promise.all([loadMagnets(), loadLogs(), loadStorage()]);
        showToast('Холодильник очищен');
        return;
      }
    }
    const close = confirm('Закрыть холодильник для новых магнитов и начать новый холодильник отдельно?');
    if (close) {
      await request('/api/admin/close-fridge', { method: 'POST' });
      await loadSettings();
      await loadStorage();
    }
  }
}

async function loadBackups() {
  const rows = await request('/api/admin/backups');
  backupSelect.replaceChildren(...rows.map(row => {
    const option = document.createElement('option');
    option.value = row.name;
    option.textContent = `${row.name} · ${formatBytes(row.size)}`;
    return option;
  }));
  if (!rows.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Бэкапов пока нет';
    backupSelect.replaceChildren(option);
  }
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
    await Promise.all([loadSettings(), loadMagnets(), loadLogs(), loadStorage(), loadBackups()]);
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
    await Promise.all([loadSettings(), loadMagnets(), loadLogs(), loadStorage(), loadBackups()]);
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
  form.append('uploadsClosed', String(uploadsClosedInput.checked));
  form.append('magnetHolders', String(magnetHoldersInput.checked));
  form.append('clearTitleImage', String(clearTitleImage.checked));
  if (titleImageInput.files[0]) {
    form.append('titleImage', titleImageInput.files[0]);
  }
  try {
    await request('/api/admin/settings', { method: 'PATCH', body: form });
    titleImageInput.value = '';
    clearTitleImage.checked = false;
    await loadStorage();
    showToast('Настройки сохранены');
  } catch (error) {
    showToast(error.message);
  }
});

refresh.addEventListener('click', () => loadMagnets().catch(error => showToast(error.message)));
refreshLogs.addEventListener('click', () => loadLogs().catch(error => showToast(error.message)));
refreshStorage.addEventListener('click', () => loadStorage().catch(error => showToast(error.message)));
closeFridge.addEventListener('click', async () => {
  await request('/api/admin/close-fridge', { method: 'POST' });
  await Promise.all([loadSettings(), loadStorage(), loadLogs()]);
  showToast('Холодильник закрыт');
});
openFridge.addEventListener('click', async () => {
  await request('/api/admin/open-fridge', { method: 'POST' });
  await Promise.all([loadSettings(), loadStorage(), loadLogs()]);
  showToast('Холодильник открыт');
});
createBackup.addEventListener('click', async () => {
  try {
    createBackup.disabled = true;
    const backup = await request('/api/admin/backups', { method: 'POST' });
    await Promise.all([loadBackups(), loadLogs(), loadStorage()]);
    backupSelect.value = backup.name;
    showToast(`Бэкап создан: ${backup.name}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    createBackup.disabled = false;
  }
});
restoreBackup.addEventListener('click', async () => {
  const name = backupSelect.value;
  if (!name) {
    showToast('Выберите бэкап');
    return;
  }
  if (!confirm(`Восстановить холодильник из ${name}? Текущие магниты и комментарии будут заменены.`)) return;
  const phrase = prompt('Для подтверждения введите: ВОССТАНОВИТЬ');
  if (phrase !== 'ВОССТАНОВИТЬ') {
    showToast('Восстановление отменено');
    return;
  }
  try {
    await request('/api/admin/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, confirm: phrase })
    });
    await Promise.all([loadSettings(), loadMagnets(), loadLogs(), loadStorage(), loadBackups()]);
    showToast('Бэкап восстановлен');
  } catch (error) {
    showToast(error.message);
  }
});
clearLogs.addEventListener('click', () => {
  clearLogsArmed = true;
  confirmClearLogs.hidden = false;
  showToast('Для очистки журнала нажмите "Точно очистить"');
  window.setTimeout(() => {
    clearLogsArmed = false;
    confirmClearLogs.hidden = true;
  }, 8000);
});
confirmClearLogs.addEventListener('click', async () => {
  if (!clearLogsArmed) return;
  try {
    const result = await request('/api/admin/logs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'ОЧИСТИТЬ ЖУРНАЛ' })
    });
    clearLogsArmed = false;
    confirmClearLogs.hidden = true;
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
