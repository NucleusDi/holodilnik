const fridge = document.querySelector('#fridge');
const magnetsLayer = document.querySelector('#magnets');
const dropHint = document.querySelector('#dropHint');
const toast = document.querySelector('#toast');
const titleText = document.querySelector('#titleText');
const titleImage = document.querySelector('#titleImage');
const mobileUpload = document.querySelector('#mobileUpload');
const mobileGalleryButton = document.querySelector('#mobileGalleryButton');
const mobileCameraButton = document.querySelector('#mobileCameraButton');
const mobileCancelButton = document.querySelector('#mobileCancelButton');
const mobileGalleryInput = document.querySelector('#mobileGalleryInput');
const mobileCameraInput = document.querySelector('#mobileCameraInput');
const uploadDialog = document.querySelector('#uploadDialog');
const uploadForm = document.querySelector('#uploadForm');
const uploadPreview = document.querySelector('#uploadPreview');
const captionInput = document.querySelector('#captionInput');
const frameStyleInput = document.querySelector('#frameStyleInput');
const frameColorInput = document.querySelector('#frameColorInput');
const cancelUpload = document.querySelector('#cancelUpload');
const closeUploadDialog = document.querySelector('#closeUploadDialog');
const imageDialog = document.querySelector('#imageDialog');
const imageDialogImg = document.querySelector('#imageDialogImg');
const imageDialogCaption = document.querySelector('#imageDialogCaption');
const closeImageDialog = document.querySelector('#closeImageDialog');

let magnets = [];
let pendingUpload = null;
let uploadDialogResolve = null;
let selectedFrameStyle = 'polaroid';
let selectedFrameColor = 'white';
let adminMode = false;
let adminDrag = null;
let fridgeScale = 1;
let suppressImageOpen = false;

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
  mobileGalleryButton.hidden = false;
  mobileCameraButton.hidden = false;
  mobileCancelButton.hidden = true;
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
  const frameStyle = ['polaroid', 'circle'].includes(magnet.frameStyle) ? magnet.frameStyle : 'polaroid';
  const frameColor = magnet.frameColor || 'white';
  el.className = `magnet frame-${frameStyle} frame-color-${frameColor} ${magnet.status === 'pending' ? 'pending' : ''}`;
  el.style.left = `${magnet.x * fridgeScale}px`;
  el.style.top = `${magnet.y * fridgeScale}px`;
  el.style.setProperty('--w', `${magnet.width * fridgeScale}px`);
  el.style.setProperty('--h', `${magnet.height * fridgeScale}px`);
  el.style.setProperty('--caption-size', `${Math.max(12, 18 * fridgeScale)}px`);
  el.style.setProperty('--like-size', `${Math.max(30, 38 * fridgeScale)}px`);
  el.style.setProperty('--r', `${rotationFor(magnet.id)}deg`);
  el.dataset.id = magnet.id;

  const media = document.createElement('div');
  media.className = 'magnet-media';

  const img = document.createElement('img');
  img.src = magnet.src;
  img.alt = magnet.originalName || 'Магнит';
  img.loading = 'lazy';
  media.append(img);
  media.addEventListener('click', (event) => {
    event.stopPropagation();
    if (suppressImageOpen) {
      suppressImageOpen = false;
      return;
    }
    openImageDialog(magnet);
  });

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
      offsetX: (event.clientX - rect.left) / fridgeScale,
      offsetY: (event.clientY - rect.top) / fridgeScale
    };
    el.setPointerCapture(event.pointerId);
    el.classList.add('moving');
  });

  el.append(media, caption, like);
  magnetsLayer.append(el);
}

function openImageDialog(magnet) {
  imageDialogImg.src = magnet.src;
  imageDialogImg.alt = magnet.caption || magnet.originalName || 'Магнит';
  imageDialogCaption.textContent = magnet.caption || '';
  imageDialogCaption.hidden = !magnet.caption;
  imageDialog.showModal();
}

function growFridge() {
  const base = window.innerHeight - (window.innerWidth <= 720 ? 16 : 36);
  const bottom = magnets.reduce((max, magnet) => Math.max(max, magnet.y + magnet.height + (magnet.caption ? 260 : 220)), base);
  const naturalHeight = Math.max(bottom * fridgeScale, base);
  fridge.style.minHeight = `${naturalHeight}px`;
  document.documentElement.style.setProperty('--fridge-height', `${naturalHeight}px`);
}

function updateFridgeScale() {
  const baseWidth = 1180;
  const available = Math.max(320, window.innerWidth - (window.innerWidth <= 720 ? 16 : 64));
  fridgeScale = window.innerWidth <= 900 ? Math.min(1, available / baseWidth) : 1;
  document.documentElement.style.setProperty('--fridge-scale', String(fridgeScale));
  magnetsLayer.replaceChildren();
  magnets.forEach(renderMagnet);
  growFridge();
}

function pointToFridge(clientX, clientY) {
  const rect = fridge.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / fridgeScale,
    y: (clientY - rect.top) / fridgeScale
  };
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
  setSelectedFrameStyle('polaroid');
  setSelectedFrameColor('white');
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

function setSelectedFrameStyle(frameStyle) {
  selectedFrameStyle = ['polaroid', 'circle'].includes(frameStyle) ? frameStyle : 'polaroid';
  frameStyleInput.querySelectorAll('[data-frame-style]').forEach(button => {
    const active = button.dataset.frameStyle === selectedFrameStyle;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
  updatePreviewClass();
}

function setSelectedFrameColor(frameColor) {
  selectedFrameColor = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'].includes(frameColor) ? frameColor : 'white';
  frameColorInput.querySelectorAll('[data-frame-color]').forEach(button => {
    const active = button.dataset.frameColor === selectedFrameColor;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
  updatePreviewClass();
}

function updatePreviewClass() {
  uploadPreview.className = `upload-preview preview-${selectedFrameStyle} frame-color-${selectedFrameColor}`;
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
  const point = pointToFridge(clientX, clientY);
  const size = upload.size;
  const x = Math.max(16, point.x - size.width / 2);
  const y = Math.max(130, point.y - size.height / 2);

  const form = new FormData();
  form.append('magnet', upload.file);
  form.append('x', String(Math.round(x)));
  form.append('y', String(Math.round(y)));
  form.append('width', String(size.width));
  form.append('height', String(size.height));
  form.append('caption', upload.caption);
  form.append('frameStyle', upload.frameStyle);
  form.append('frameColor', upload.frameColor);

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

function chooseMobileFile(input) {
  if (pendingUpload) {
    resetMobilePlacement();
    return;
  }
  input.click();
}

async function handleMobileFile(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    pendingUpload = await prepareUpload(file);
    if (!pendingUpload) return;
    fridge.classList.add('placing');
    mobileUpload.classList.add('placing');
    mobileGalleryButton.hidden = true;
    mobileCameraButton.hidden = true;
    mobileCancelButton.hidden = false;
    dropHint.textContent = 'Тапните место для магнита';
    showToast('Теперь тапните по холодильнику');
  } catch (error) {
    showToast(error.message);
    resetMobilePlacement();
  }
}

mobileGalleryButton.addEventListener('click', () => chooseMobileFile(mobileGalleryInput));
mobileCameraButton.addEventListener('click', () => chooseMobileFile(mobileCameraInput));
mobileCancelButton.addEventListener('click', resetMobilePlacement);
mobileGalleryInput.addEventListener('change', () => handleMobileFile(mobileGalleryInput));
mobileCameraInput.addEventListener('change', () => handleMobileFile(mobileCameraInput));

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
    frameStyle: selectedFrameStyle,
    frameColor: selectedFrameColor
  });
});

cancelUpload.addEventListener('click', () => uploadDialogResolve?.(null));
closeUploadDialog.addEventListener('click', () => uploadDialogResolve?.(null));
closeImageDialog.addEventListener('click', () => imageDialog.close());
imageDialog.addEventListener('click', (event) => {
  if (event.target === imageDialog) imageDialog.close();
});
frameStyleInput.addEventListener('click', (event) => {
  const button = event.target.closest('[data-frame-style]');
  if (!button) return;
  setSelectedFrameStyle(button.dataset.frameStyle);
});
frameColorInput.addEventListener('click', (event) => {
  const button = event.target.closest('[data-frame-color]');
  if (!button) return;
  setSelectedFrameColor(button.dataset.frameColor);
});

window.addEventListener('pointermove', (event) => {
  if (!adminDrag) return;
  const point = pointToFridge(event.clientX, event.clientY);
  const x = Math.max(8, point.x - adminDrag.offsetX);
  const y = Math.max(8, point.y - adminDrag.offsetY);
  if (Math.abs(x - adminDrag.magnet.x) > 2 || Math.abs(y - adminDrag.magnet.y) > 2) {
    adminDrag.moved = true;
  }
  adminDrag.element.style.left = `${x * fridgeScale}px`;
  adminDrag.element.style.top = `${y * fridgeScale}px`;
});

window.addEventListener('pointerup', async () => {
  if (!adminDrag) return;
  const drag = adminDrag;
  adminDrag = null;
  suppressImageOpen = Boolean(drag.moved);
  drag.element.classList.remove('moving');
  const x = Math.round(parseFloat(drag.element.style.left) / fridgeScale);
  const y = Math.round(parseFloat(drag.element.style.top) / fridgeScale);
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

window.addEventListener('resize', updateFridgeScale);
updateFridgeScale();
loadAll().catch(error => showToast(error.message));
