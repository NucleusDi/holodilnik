const loginPanel = document.querySelector('#loginPanel');
const adminPanel = document.querySelector('#adminPanel');
const loginForm = document.querySelector('#loginForm');
const password = document.querySelector('#password');
const logout = document.querySelector('#logout');
const settingsForm = document.querySelector('#settingsForm');
const titleTextInput = document.querySelector('#titleTextInput');
const titleImageInput = document.querySelector('#titleImageInput');
const moderationInput = document.querySelector('#moderationInput');
const clearTitleImage = document.querySelector('#clearTitleImage');
const refresh = document.querySelector('#refresh');
const adminMagnets = document.querySelector('#adminMagnets');
const toast = document.querySelector('#toast');

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

async function loadSettings() {
  const cfg = await request('/api/settings');
  titleTextInput.value = cfg.titleText || 'Наш холодильник';
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
  meta.innerHTML = `<span>${magnet.status === 'pending' ? 'на модерации' : 'опубликован'}</span><span>♥ ${magnet.likes}</span>`;

  const actions = document.createElement('div');
  actions.className = 'admin-actions';

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'secondary';
  approve.textContent = magnet.status === 'pending' ? 'Одобрить' : 'Скрыть';
  approve.addEventListener('click', async () => {
    await request(`/api/admin/magnets/${magnet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: magnet.status === 'pending' ? 'approved' : 'pending' })
    });
    await loadMagnets();
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Удалить';
  remove.addEventListener('click', async () => {
    if (!confirm('Удалить магнит навсегда?')) return;
    await request(`/api/admin/magnets/${magnet.id}`, { method: 'DELETE' });
    await loadMagnets();
  });

  actions.append(approve, remove);
  el.append(img, meta, actions);
  return el;
}

async function loadMagnets() {
  const rows = await request('/api/magnets?all=1');
  adminMagnets.replaceChildren(...rows.map(card));
  if (!rows.length) {
    adminMagnets.textContent = 'Магнитов пока нет.';
  }
}

async function boot() {
  const me = await request('/api/admin/me');
  setAuthed(me.admin);
  if (me.admin) {
    await Promise.all([loadSettings(), loadMagnets()]);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await request('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value })
    });
    password.value = '';
    setAuthed(true);
    await Promise.all([loadSettings(), loadMagnets()]);
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
boot().catch(() => setAuthed(false));
