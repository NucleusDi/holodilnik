const fridge = document.querySelector('#fridge');
const magnetsLayer = document.querySelector('#magnets');
const dropHint = document.querySelector('#dropHint');
const toast = document.querySelector('#toast');
const titleText = document.querySelector('#titleText');
const titleImage = document.querySelector('#titleImage');
const mobileUpload = document.querySelector('#mobileUpload');
const mobileUploadButton = document.querySelector('#mobileUploadButton');
const mobileMagnetInput = document.querySelector('#mobileMagnetInput');
const uploadDialog = document.querySelector('#uploadDialog');
const uploadForm = document.querySelector('#uploadForm');
const uploadPreview = document.querySelector('#uploadPreview');
const captionInput = document.querySelector('#captionInput');
const frameStyleInput = document.querySelector('#frameStyleInput');
const cancelUpload = document.querySelector('#cancelUpload');
const closeUploadDialog = document.querySelector('#closeUploadDialog');

let magnets = [];
let pendingUpload = null;
let uploadDialogResolve = null;
let adminMode = false;
let adminDrag = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function resetMobilePlacement() {
  pendingUpload = null;
  fridge.classList.remove('placing');
  mobileUpload.classList.remove('placing');
  mobileUploadButton.textContent = 'Выбрать магнит';
  dropHint.textContent = 'Перетащите картинку на холодильник';
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Что-то пошло не так');
  }
  return data;
}

function rotationFor(id) {
  let n = 0;
  for (const ch of id) n += ch.charCodeAt(0);
  return ((n % 13) - 6) / 2;
}

function renderMagnet(magnet) {
  const el = document.createElement('article');
  el.className = `magnet frame-${magnet.frameStyle || 'polaroid'} ${magnet.status === 'pending' ? 'pending' : ''}`;
  el.style.left = `${magnet.x}px`;
  el.style.top = `${magnet.y}px`;
  el.style.setProperty('--w', `${magnet.width}px`);
  el.style.setProperty('--h', `${magnet.height}px`);
  el.style.setProperty('--r', `${rotationFor(magnet.id)}deg`);
  el.dataset.id = magnet.id;

  const img = document.createElement('img');
  img.src = magnet.src;
  img.alt = magnet.originalName || 'Магнит';
  img.loading = 'lazy';

  const caption = document.createElement('p');
  caption.className = 'caption';
  caption.textContent = magnet.caption || '';
  caption.hidden = !magnet.caption;

  const like = document.createElement('button');
  like.className = 'like';
  like.type = 'button';
  like.textContent = magnet.likes;
  like.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      const result = await request(`/api/magnets/${magnet.id}/like`, { method: 'POST' });
      like.textContent = result.likes;
    } catch (error) {
      showToast(error.message);
    }
  });

  el.addEventListener('pointerdown', (event) => {
    if (!adminMode || event.target.closest('.like')) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    adminDrag = {
      id: magnet.id,
      element: el,
      magnet,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    el.setPointerCapture(event.pointerId);
    el.classList.add('moving');
  });

  el.append(img, caption, like);
  magnetsLayer.append(el);
}

function growFridge() {
  const base = window.innerHeight - (window.innerWidth <= 720 ? 16 : 36);
  const bottom = magnets.reduce((max, magnet) => Math.max(max, magnet.y + magnet.height + (magnet.caption ? 260 : 220)), base);
  fridge.style.minHeight = `${Math.max(bottom, base)}px`;
}

async function loadAll() {
  const [cfg, rows] = await Promise.all([
    request('/api/settings'),
    request('/api/magnets')
  ]);

  document.title = cfg.titleText || 'Наш холодильник';
  titleText.textContent = cfg.titleText || 'Наш холодильник';
  titleText.style.color = cfg.titleColor || '#2a363b';
  titleText.className = `title-font-${cfg.titleFont || 'classic'}`;
  if (cfg.titleImage) {
    titleImage.src = cfg.titleImage;
    titleImage.hidden = false;
    titleText.hidden = true;
  } else {
    titleImage.hidden = true;
    titleText.hidden = false;
  }

  magnets = rows;
  magnetsLayer.replaceChildren();
  magnets.forEach(renderMagnet);
  growFridge();
  const me = await request('/api/admin/me').catch(() => ({ admin: false }));
  adminMode = Boolean(me.admin);
  if (adminMode) showToast('Админ-режим: магниты можно перетаскивать');
}

function imageSize(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const max = 220;
      const scale = Math.min(max / img.naturalWidth, max / img.naturalHeight, 1);
      resolve({
        width: Math.round(Math.max(img.naturalWidth * scale, 90)),
        height: Math.round(Math.max(img.naturalHeight * scale, 90))
      });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function compressImage(file) {
  if (file.type === 'image/gif' || file.size < 900 * 1024) return file;
  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  URL.revokeObjectURL(url);
  const maxSide = 1600;
  const scale = Math.min(maxSide / img.naturalWidth, maxSide / img.naturalHeight, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
}

function showUploadDialog(file) {
  uploadPreview.src = URL.createObjectURL(file);
  captionInput.value = '';
  frameStyleInput.value = 'polaroid';
  uploadDialog.showModal();
  captionInput.focus();
  return new Promise(resolve => {
    uploadDialogResolve = (value) => {
      URL.revokeObjectURL(uploadPreview.src);
      uploadDialog.close();
      uploadDialogResolve = null;
      resolve(value);
    };
  });
}

async function prepareUpload(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Нужна картинка: PNG, JPG, GIF или WebP');
    return null;
  }
  const compressed = await compressImage(file);
  const size = await imageSize(compressed);
  const details = await showUploadDialog(compressed);
  if (!details) return null;
  return { file: compressed, size, ...details };
}

async function uploadAt(upload, clientX, clientY) {
  if (!upload) return;
  const rect = fridge.getBoundingClientRect();
  const size = upload.size;
  const x = Math.max(16, clientX - rect.left - size.width / 2);
  const y = Math.max(130, clientY - rect.top - size.height / 2);

  const form = new FormData();
  form.append('magnet', upload.file);
  form.append('x', String(Math.round(x)));
  form.append('y', String(Math.round(y)));
  form.append('width', String(size.width));
  form.append('height', String(size.height));
  form.append('caption', upload.caption);
  form.append('frameStyle', upload.frameStyle);

  const magnet = await request('/api/magnets', { method: 'POST', body: form });
  if (magnet.status === 'approved') {
    magnets.push(magnet);
    renderMagnet(magnet);
    growFridge();
    showToast('Магнит прилип');
  } else {
    showToast('Магнит отправлен на модерацию');
  }
  resetMobilePlacement();
}

fridge.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropHint.classList.add('active');
  dropHint.textContent = 'Отпустите картинку здесь';
});

fridge.addEventListener('dragleave', () => {
  dropHint.classList.remove('active');
  dropHint.textContent = 'Перетащите картинку на холодильник';
});

fridge.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropHint.classList.remove('active');
  dropHint.textContent = 'Перетащите картинку на холодильник';
  try {
    const upload = await prepareUpload(event.dataTransfer.files[0]);
    await uploadAt(upload, event.clientX, event.clientY);
  } catch (error) {
    showToast(error.message);
  }
});

mobileUploadButton.addEventListener('click', () => {
  if (pendingUpload) {
    resetMobilePlacement();
    return;
  }
  mobileMagnetInput.click();
});

mobileMagnetInput.addEventListener('change', async () => {
  const file = mobileMagnetInput.files[0];
  mobileMagnetInput.value = '';
  if (!file) return;
  try {
    pendingUpload = await prepareUpload(file);
    if (!pendingUpload) return;
    fridge.classList.add('placing');
    mobileUpload.classList.add('placing');
    mobileUploadButton.textContent = 'Отменить';
    dropHint.textContent = 'Тапните место для магнита';
    showToast('Теперь тапните по холодильнику');
  } catch (error) {
    showToast(error.message);
    resetMobilePlacement();
  }
});

fridge.addEventListener('click', async (event) => {
  if (!pendingUpload) return;
  if (event.target.closest('.magnet') || event.target.closest('.mobile-upload')) return;
  try {
    await uploadAt(pendingUpload, event.clientX, event.clientY);
  } catch (error) {
    showToast(error.message);
    resetMobilePlacement();
  }
});

uploadForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!uploadDialogResolve) return;
  uploadDialogResolve({
    caption: captionInput.value.trim().slice(0, 30),
    frameStyle: frameStyleInput.value
  });
});

cancelUpload.addEventListener('click', () => uploadDialogResolve?.(null));
closeUploadDialog.addEventListener('click', () => uploadDialogResolve?.(null));

window.addEventListener('pointermove', (event) => {
  if (!adminDrag) return;
  const rect = fridge.getBoundingClientRect();
  const x = Math.max(8, event.clientX - rect.left - adminDrag.offsetX);
  const y = Math.max(8, event.clientY - rect.top - adminDrag.offsetY);
  adminDrag.element.style.left = `${x}px`;
  adminDrag.element.style.top = `${y}px`;
});

window.addEventListener('pointerup', async () => {
  if (!adminDrag) return;
  const drag = adminDrag;
  adminDrag = null;
  drag.element.classList.remove('moving');
  const x = Math.round(parseFloat(drag.element.style.left));
  const y = Math.round(parseFloat(drag.element.style.top));
  try {
    await request(`/api/admin/magnets/${drag.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y })
    });
    drag.magnet.x = x;
    drag.magnet.y = y;
    growFridge();
    showToast('Позиция сохранена');
  } catch (error) {
    drag.element.style.left = `${drag.magnet.x}px`;
    drag.element.style.top = `${drag.magnet.y}px`;
    showToast(error.message);
  }
});

window.addEventListener('resize', growFridge);
loadAll().catch(error => showToast(error.message));
