const fridge = document.querySelector('#fridge');
const magnetsLayer = document.querySelector('#magnets');
const dropHint = document.querySelector('#dropHint');
const toast = document.querySelector('#toast');
const titleText = document.querySelector('#titleText');
const titleImage = document.querySelector('#titleImage');
const mobileUpload = document.querySelector('#mobileUpload');
const mobileUploadButton = document.querySelector('#mobileUploadButton');
const mobileMagnetInput = document.querySelector('#mobileMagnetInput');

let magnets = [];
let pendingMobileFile = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function resetMobilePlacement() {
  pendingMobileFile = null;
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
  el.className = `magnet ${magnet.status === 'pending' ? 'pending' : ''}`;
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

async function uploadAt(file, clientX, clientY) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Нужна картинка: PNG, JPG, GIF или WebP');
    return;
  }

  const caption = (window.prompt('Подпись под магнитом, до 30 символов', '') || '').trim().slice(0, 30);
  const rect = fridge.getBoundingClientRect();
  const size = await imageSize(file);
  const x = Math.max(16, clientX - rect.left - size.width / 2);
  const y = Math.max(130, clientY - rect.top - size.height / 2);

  const form = new FormData();
  form.append('magnet', file);
  form.append('x', String(Math.round(x)));
  form.append('y', String(Math.round(y)));
  form.append('width', String(size.width));
  form.append('height', String(size.height));
  form.append('caption', caption);

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
    await uploadAt(event.dataTransfer.files[0], event.clientX, event.clientY);
  } catch (error) {
    showToast(error.message);
  }
});

mobileUploadButton.addEventListener('click', () => {
  if (pendingMobileFile) {
    resetMobilePlacement();
    return;
  }
  mobileMagnetInput.click();
});

mobileMagnetInput.addEventListener('change', () => {
  const file = mobileMagnetInput.files[0];
  mobileMagnetInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Нужна картинка: PNG, JPG, GIF или WebP');
    return;
  }
  pendingMobileFile = file;
  fridge.classList.add('placing');
  mobileUpload.classList.add('placing');
  mobileUploadButton.textContent = 'Отменить';
  dropHint.textContent = 'Тапните место для магнита';
  showToast('Теперь тапните по холодильнику');
});

fridge.addEventListener('click', async (event) => {
  if (!pendingMobileFile) return;
  if (event.target.closest('.magnet') || event.target.closest('.mobile-upload')) return;
  try {
    await uploadAt(pendingMobileFile, event.clientX, event.clientY);
  } catch (error) {
    showToast(error.message);
    resetMobilePlacement();
  }
});

window.addEventListener('resize', growFridge);
loadAll().catch(error => showToast(error.message));
