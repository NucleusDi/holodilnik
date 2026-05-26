const fridge = document.querySelector('#fridge');
const magnetsLayer = document.querySelector('#magnets');
const dropHint = document.querySelector('#dropHint');
const toast = document.querySelector('#toast');
const titleText = document.querySelector('#titleText');
const titleImage = document.querySelector('#titleImage');
const mobileUpload = document.querySelector('#mobileUpload');
const mobileGalleryButton = document.querySelector('#mobileGalleryButton');
const mobileCameraButton = document.querySelector('#mobileCameraButton');
const mobilePasteButton = document.querySelector('#mobilePasteButton');
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
const commentsToggle = document.querySelector('#commentsToggle');
const commentsPanel = document.querySelector('#commentsPanel');
const commentsList = document.querySelector('#commentsList');
const commentForm = document.querySelector('#commentForm');
const commentInput = document.querySelector('#commentInput');

let magnets = [];
let pendingUpload = null;
let uploadDialogResolve = null;
let selectedFrameStyle = 'polaroid';
let selectedFrameColor = 'white';
let adminMode = false;
let adminDrag = null;
let fridgeScale = 1;
let suppressImageOpen = false;
let activeMagnet = null;
let uploadsClosed = false;
let editableMagnet = null;
let editableDrag = null;

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
  mobilePasteButton.hidden = false;
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

async function finalizeEditableMagnet() {
  if (!editableMagnet) return;
  const current = editableMagnet;
  editableMagnet = null;
  current.element.classList.remove('editable', 'moving');
  current.element.querySelector('.edit-delete')?.remove();
  await request(`/api/magnets/${current.id}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editToken: current.token })
  });
}

async function deleteEditableMagnet() {
  if (!editableMagnet) return;
  const current = editableMagnet;
  editableMagnet = null;
  await request(`/api/magnets/${current.id}/placement`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editToken: current.token })
  });
  magnets = magnets.filter(magnet => magnet.id !== current.id);
  current.element.remove();
  growFridge();
  showToast('Магнит удален');
}

function renderMagnet(magnet, options = {}) {
  const el = document.createElement('article');
  const frameStyle = ['polaroid', 'circle', 'mini'].includes(magnet.frameStyle) ? magnet.frameStyle : 'polaroid';
  const frameColor = magnet.frameColor || 'white';
  el.className = `magnet frame-${frameStyle} frame-color-${frameColor} ${magnet.status === 'pending' ? 'pending' : ''}`;
  if (magnet.holder) el.classList.add('has-holder');
  if (options.editToken) el.classList.add('editable');
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
    if (editableMagnet?.id === magnet.id) return;
    if (suppressImageOpen) {
      suppressImageOpen = false;
      return;
    }
    openImageDialog(magnet);
  });

  let holder = null;
  if (magnet.holder && frameStyle !== 'mini') {
    holder = document.createElement('img');
    holder.className = 'magnet-holder';
    holder.src = '/assets/magnet-holder-cutout.png';
    holder.alt = '';
    holder.loading = 'lazy';
    holder.draggable = false;
  }

  const caption = document.createElement('p');
  caption.className = 'caption';
  caption.textContent = frameStyle === 'mini' ? '' : (magnet.caption || '');
  caption.hidden = frameStyle === 'mini' || !magnet.caption;

  let like = null;
  if (frameStyle !== 'mini') {
    like = document.createElement('button');
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
  }

  el.addEventListener('pointerdown', (event) => {
    if (editableMagnet?.id === magnet.id && !event.target.closest('.edit-delete')) {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      editableDrag = {
        id: magnet.id,
        token: editableMagnet.token,
        element: el,
        magnet,
        offsetX: (event.clientX - rect.left) / fridgeScale,
        offsetY: (event.clientY - rect.top) / fridgeScale
      };
      el.setPointerCapture(event.pointerId);
      el.classList.add('moving');
      return;
    }
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

  el.addEventListener('focusout', (event) => {
    if (editableMagnet?.id !== magnet.id) return;
    if (event.relatedTarget && el.contains(event.relatedTarget)) return;
    finalizeEditableMagnet().catch(error => showToast(error.message));
  });

  el.append(media);
  if (holder) el.append(holder);
  el.append(caption);
  if (like) el.append(like);
  if (options.editToken) {
    el.tabIndex = -1;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'edit-delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Удалить новый магнит');
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteEditableMagnet().catch(error => showToast(error.message));
    });
    el.append(remove);
    editableMagnet = { id: magnet.id, token: options.editToken, element: el, magnet };
    requestAnimationFrame(() => el.focus({ preventScroll: true }));
    showToast('Можно один раз поправить магнит или удалить его');
  }
  magnetsLayer.append(el);
  return el;
}

function openImageDialog(magnet) {
  activeMagnet = magnet;
  imageDialogImg.src = magnet.src;
  imageDialogImg.alt = magnet.caption || magnet.originalName || 'Магнит';
  imageDialogCaption.textContent = magnet.caption || '';
  imageDialogCaption.hidden = !magnet.caption;
  commentsPanel.hidden = true;
  commentsList.replaceChildren();
  commentInput.value = '';
  commentsToggle.textContent = magnet.commentCount || 0;
  imageDialog.showModal();
}

function renderComments(rows) {
  commentsList.replaceChildren(...rows.map(comment => {
    const el = document.createElement('article');
    el.className = 'comment-row';
    const body = document.createElement('p');
    body.textContent = comment.body;
    const time = document.createElement('time');
    time.textContent = comment.createdAt;
    el.append(body, time);
    return el;
  }));
  if (!rows.length) {
    commentsList.textContent = 'Комментариев пока нет.';
  }
}

async function loadComments() {
  if (!activeMagnet) return;
  const rows = await request(`/api/magnets/${activeMagnet.id}/comments`);
  renderComments(rows);
  commentsToggle.textContent = rows.length;
  activeMagnet.commentCount = rows.length;
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
  const editableState = editableMagnet ? { id: editableMagnet.id, token: editableMagnet.token } : null;
  editableMagnet = null;
  magnetsLayer.replaceChildren();
  magnets.forEach(magnet => {
    renderMagnet(magnet, editableState?.id === magnet.id ? { editToken: editableState.token } : {});
  });
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
  uploadsClosed = Boolean(cfg.uploadsClosed);
  mobileUpload.hidden = uploadsClosed;
  dropHint.hidden = uploadsClosed;
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

async function cleanMiniImage(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  URL.revokeObjectURL(url);

  const maxSide = 1200;
  const scale = Math.min(maxSide / img.naturalWidth, maxSide / img.naturalHeight, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const width = canvas.width;
  const height = canvas.height;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = [];

  const isBlackish = (index) => {
    const offset = index * 4;
    return data[offset + 3] > 0 && data[offset] < 36 && data[offset + 1] < 36 && data[offset + 2] < 36;
  };
  const push = (index) => {
    if (visited[index] || !isBlackish(index)) return;
    visited[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (y > 0) push(index - width);
    if (y < height - 1) push(index + width);
  }

  for (const index of queue) {
    data[index * 4 + 3] = 0;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return new File([blob], file.name.replace(/\.[^.]+$/, '.png'), { type: 'image/png' });
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
  selectedFrameColor = ['white', 'red', 'orange', 'yellow', 'green', 'blue'].includes(frameColor) ? frameColor : 'white';
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

async function readClipboardImage() {
  if (!navigator.clipboard?.read) {
    throw new Error('Браузер не дал доступ к картинке из буфера');
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find(value => value.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    return new File([blob], `mini-magnet.${type.split('/')[1] || 'png'}`, { type });
  }
  throw new Error('В буфере обмена нет картинки');
}

async function uploadAt(upload, clientX, clientY) {
  if (!upload) return;
  await finalizeEditableMagnet();
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
    const editToken = magnet.editToken;
    delete magnet.editToken;
    magnets.push(magnet);
    renderMagnet(magnet, { editToken });
    growFridge();
  } else {
    showToast('Магнит отправлен на модерацию');
  }
  resetMobilePlacement();
}

fridge.addEventListener('dragover', (event) => {
  if (uploadsClosed) return;
  event.preventDefault();
  dropHint.classList.add('active');
  dropHint.textContent = 'Отпустите картинку здесь';
});

fridge.addEventListener('dragleave', () => {
  dropHint.classList.remove('active');
  dropHint.textContent = 'Перетащите картинку на холодильник';
});

fridge.addEventListener('drop', async (event) => {
  if (uploadsClosed) return;
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
  if (uploadsClosed) {
    showToast('Холодильник закрыт для новых магнитов');
    return;
  }
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
    mobilePasteButton.hidden = true;
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
mobilePasteButton.addEventListener('click', async () => {
  if (uploadsClosed) {
    showToast('Холодильник закрыт для новых магнитов');
    return;
  }
  if (pendingUpload) {
    resetMobilePlacement();
    return;
  }
  try {
    const file = await readClipboardImage();
    const cleaned = await cleanMiniImage(file);
    const size = await imageSize(cleaned);
    pendingUpload = {
      file: cleaned,
      size,
      caption: '',
      frameStyle: 'mini',
      frameColor: 'white'
    };
    fridge.classList.add('placing');
    mobileUpload.classList.add('placing');
    mobileGalleryButton.hidden = true;
    mobileCameraButton.hidden = true;
    mobilePasteButton.hidden = true;
    mobileCancelButton.hidden = false;
    dropHint.textContent = 'Тапните место для мини-магнита';
    showToast('Мини-магнит готов. Тапните по холодильнику');
  } catch (error) {
    showToast(error.message);
  }
});
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

document.addEventListener('pointerdown', (event) => {
  if (!editableMagnet) return;
  if (editableMagnet.element.contains(event.target)) return;
  finalizeEditableMagnet().catch(error => showToast(error.message));
}, true);

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
commentsToggle.addEventListener('click', async () => {
  commentsPanel.hidden = !commentsPanel.hidden;
  if (!commentsPanel.hidden) {
    try {
      await loadComments();
      commentInput.focus();
    } catch (error) {
      showToast(error.message);
    }
  }
});
commentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeMagnet) return;
  try {
    const comment = await request(`/api/magnets/${activeMagnet.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentInput.value })
    });
    commentInput.value = '';
    if (commentsList.textContent === 'Комментариев пока нет.') commentsList.replaceChildren();
    const current = await request(`/api/magnets/${activeMagnet.id}/comments`);
    renderComments(current);
    commentsToggle.textContent = current.length;
    activeMagnet.commentCount = current.length;
    showToast('Комментарий добавлен');
  } catch (error) {
    showToast(error.message);
  }
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
  if (editableDrag) {
    const point = pointToFridge(event.clientX, event.clientY);
    const x = Math.max(8, point.x - editableDrag.offsetX);
    const y = Math.max(8, point.y - editableDrag.offsetY);
    editableDrag.moved = true;
    editableDrag.element.style.left = `${x * fridgeScale}px`;
    editableDrag.element.style.top = `${y * fridgeScale}px`;
    return;
  }
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
  if (editableDrag) {
    const drag = editableDrag;
    editableDrag = null;
    suppressImageOpen = Boolean(drag.moved);
    drag.element.classList.remove('moving');
    const x = Math.round(parseFloat(drag.element.style.left) / fridgeScale);
    const y = Math.round(parseFloat(drag.element.style.top) / fridgeScale);
    try {
      await request(`/api/magnets/${drag.id}/placement`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, editToken: drag.token })
      });
      drag.magnet.x = x;
      drag.magnet.y = y;
      growFridge();
    } catch (error) {
      drag.element.style.left = `${drag.magnet.x * fridgeScale}px`;
      drag.element.style.top = `${drag.magnet.y * fridgeScale}px`;
      showToast(error.message);
    }
    return;
  }
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
