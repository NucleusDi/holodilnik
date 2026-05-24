const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

require('dotenv').config();

const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MEMS_DIR = path.join(ROOT, 'mems');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'holodilnik.sqlite');
const MAX_MAGNET_SIZE = 8 * 1024 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pass';
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_LIMIT = 10;
const uploadHits = new Map();

fs.mkdirSync(MEMS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS magnets (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    original_name TEXT,
    caption TEXT NOT NULL DEFAULT '',
    frame_style TEXT NOT NULL DEFAULT 'polaroid',
    frame_color TEXT NOT NULL DEFAULT 'white',
    x REAL NOT NULL,
    y REAL NOT NULL,
    width INTEGER NOT NULL DEFAULT 160,
    height INTEGER NOT NULL DEFAULT 160,
    likes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'approved',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS liked_magnets (
    magnet_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (magnet_id, voter_id)
  );

  CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const magnetColumns = db.prepare('PRAGMA table_info(magnets)').all().map(column => column.name);
if (!magnetColumns.includes('caption')) {
  db.exec("ALTER TABLE magnets ADD COLUMN caption TEXT NOT NULL DEFAULT ''");
}
if (!magnetColumns.includes('frame_style')) {
  db.exec("ALTER TABLE magnets ADD COLUMN frame_style TEXT NOT NULL DEFAULT 'polaroid'");
}
if (!magnetColumns.includes('frame_color')) {
  db.exec("ALTER TABLE magnets ADD COLUMN frame_color TEXT NOT NULL DEFAULT 'white'");
}

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('title_text', process.env.SITE_TITLE || 'Наш холодильник');
insertSetting.run('title_image', '');
insertSetting.run('moderation', 'false');
insertSetting.run('title_color', '#2a363b');
insertSetting.run('title_font', 'classic');

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function settings() {
  return {
    titleText: getSetting.get('title_text')?.value || 'Наш холодильник',
    titleImage: getSetting.get('title_image')?.value || '',
    moderation: getSetting.get('moderation')?.value === 'true',
    titleColor: getSetting.get('title_color')?.value || '#2a363b',
    titleFont: getSetting.get('title_font')?.value || 'classic'
  };
}

function isAdmin(req) {
  return Boolean(req.session?.admin);
}

function clientKey(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

function ipHash(req) {
  return crypto.createHash('sha256').update(String(clientKey(req))).digest('hex').slice(0, 20);
}

function cleanFrameStyle(value) {
  return ['polaroid', 'circle', 'mini'].includes(value) ? value : 'polaroid';
}

function cleanFrameColor(value) {
  return ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'].includes(value) ? value : 'white';
}

function cleanColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#2a363b';
}

function cleanTitleFont(value) {
  return ['classic', 'hand', 'strict'].includes(value) ? value : 'classic';
}

function logAdmin(action, details = {}) {
  db.prepare('INSERT INTO admin_logs (action, details) VALUES (?, ?)').run(action, JSON.stringify(details));
}

function checkUploadRate(req, res, next) {
  if (isAdmin(req)) {
    next();
    return;
  }
  const key = clientKey(req);
  const now = Date.now();
  const hits = (uploadHits.get(key) || []).filter(time => now - time < UPLOAD_WINDOW_MS);
  if (hits.length >= UPLOAD_LIMIT) {
    res.status(429).json({ error: 'Слишком много загрузок. Попробуйте чуть позже.' });
    return;
  }
  hits.push(now);
  uploadHits.set(key, hits);
  next();
}

function isSupportedImage(file) {
  const buffer = fs.readFileSync(file.path);
  if (buffer.length < 12) return false;
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isGif = buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
  const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return isPng || isJpg || isGif || isWebp;
}

function rejectUpload(file, res, message) {
  if (file) fs.unlink(file.path, () => {});
  res.status(400).json({ error: message });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEMS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext || '.img'}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MAGNET_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)) {
      cb(new Error('Разрешены только PNG, JPG, GIF или WebP'));
      return;
    }
    cb(null, true);
  }
});

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'holodilnik.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));
app.use('/mems', express.static(MEMS_DIR, { immutable: true, maxAge: '30d' }));
app.use(express.static(path.join(ROOT, 'public')));

app.use((req, res, next) => {
  if (!req.cookies.fridge_voter) {
    res.cookie('fridge_voter', crypto.randomUUID(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
  }
  next();
});

app.get('/api/settings', (_req, res) => {
  res.json(settings());
});

app.get('/api/magnets', (req, res) => {
  const includePending = isAdmin(req) && req.query.all === '1';
  const rows = db.prepare(`
    SELECT id, file_name AS fileName, original_name AS originalName, caption, frame_style AS frameStyle, frame_color AS frameColor, x, y, width, height, likes, status, created_at AS createdAt
    FROM magnets
    WHERE ${includePending ? '1 = 1' : "status = 'approved'"}
    ORDER BY created_at ASC
  `).all();
  res.json(rows.map(row => ({ ...row, src: `/mems/${row.fileName}` })));
});

app.post('/api/magnets', checkUploadRate, upload.single('magnet'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Добавьте картинку магнита' });
    return;
  }
  if (!isSupportedImage(req.file)) {
    rejectUpload(req.file, res, 'Файл не похож на изображение PNG, JPG, GIF или WebP');
    return;
  }

  const x = Number(req.body.x);
  const y = Number(req.body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: 'Некорректная позиция магнита' });
    return;
  }

  const cfg = settings();
  const frameStyle = cleanFrameStyle(req.body.frameStyle || req.body.frame_style);
  const caption = frameStyle === 'mini' ? '' : String(req.body.caption || '').trim().slice(0, 30);
  const frameColor = frameStyle === 'mini' ? 'white' : cleanFrameColor(req.body.frameColor || req.body.frame_color);
  const id = crypto.randomUUID();
  const row = {
    id,
    fileName: req.file.filename,
    originalName: req.file.originalname,
    caption,
    frameStyle,
    frameColor,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.min(Math.max(Number(req.body.width) || 160, 80), 360),
    height: Math.min(Math.max(Number(req.body.height) || 160, 80), 360),
    likes: 0,
    status: cfg.moderation ? 'pending' : 'approved'
  };

  db.prepare(`
    INSERT INTO magnets (id, file_name, original_name, caption, frame_style, frame_color, x, y, width, height, status)
    VALUES (@id, @fileName, @originalName, @caption, @frameStyle, @frameColor, @x, @y, @width, @height, @status)
  `).run(row);

  res.status(201).json({ ...row, src: `/mems/${row.fileName}` });
});

app.post('/api/magnets/:id/like', (req, res) => {
  const voter = `${req.cookies.fridge_voter || crypto.randomUUID()}:${ipHash(req)}`;
  const magnet = db.prepare("SELECT id, likes, frame_style AS frameStyle FROM magnets WHERE id = ? AND status = 'approved'").get(req.params.id);
  if (!magnet) {
    res.status(404).json({ error: 'Магнит не найден' });
    return;
  }
  if (magnet.frameStyle === 'mini') {
    res.status(400).json({ error: 'Мини-магниты нельзя лайкать' });
    return;
  }

  const vote = db.transaction(() => {
    const result = db.prepare('INSERT OR IGNORE INTO liked_magnets (magnet_id, voter_id) VALUES (?, ?)').run(req.params.id, voter);
    if (result.changes) {
      db.prepare('UPDATE magnets SET likes = likes + 1 WHERE id = ?').run(req.params.id);
    }
    return db.prepare('SELECT likes FROM magnets WHERE id = ?').get(req.params.id).likes;
  });

  res.json({ likes: vote(), liked: true });
});

app.post('/api/admin/login', async (req, res) => {
  const pass = String(req.body.password || '');
  const configured = ADMIN_PASSWORD.startsWith('$2') ? await bcrypt.compare(pass, ADMIN_PASSWORD) : pass === ADMIN_PASSWORD;
  if (!configured) {
    res.status(401).json({ error: 'Неверный пароль' });
    return;
  }
  req.session.admin = true;
  logAdmin('login', { ip: ipHash(req) });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ admin: isAdmin(req) });
});

app.use('/api/admin', (req, res, next) => {
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'Нужен вход администратора' });
    return;
  }
  next();
});

app.patch('/api/admin/settings', upload.single('titleImage'), (req, res) => {
  if (req.file && !isSupportedImage(req.file)) {
    rejectUpload(req.file, res, 'Файл заголовка должен быть PNG, JPG, GIF или WebP');
    return;
  }
  if (typeof req.body.titleText === 'string') {
    setSetting.run('title_text', req.body.titleText.trim().slice(0, 80) || 'Наш холодильник');
  }
  if (typeof req.body.moderation === 'string') {
    setSetting.run('moderation', req.body.moderation === 'true' ? 'true' : 'false');
  }
  if (req.file) {
    setSetting.run('title_image', `/mems/${req.file.filename}`);
  }
  if (req.body.clearTitleImage === 'true') {
    setSetting.run('title_image', '');
  }
  if (typeof req.body.titleColor === 'string') {
    setSetting.run('title_color', cleanColor(req.body.titleColor));
  }
  if (typeof req.body.titleFont === 'string') {
    setSetting.run('title_font', cleanTitleFont(req.body.titleFont));
  }
  const cfg = settings();
  logAdmin('settings:update', cfg);
  res.json(cfg);
});

app.patch('/api/admin/magnets/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM magnets WHERE id = ?').get(req.params.id);
  if (!current) {
    res.status(404).json({ error: 'Магнит не найден' });
    return;
  }
  const next = {
    id: req.params.id,
    status: typeof req.body.status === 'string' ? (req.body.status === 'pending' ? 'pending' : 'approved') : current.status,
    x: Number.isFinite(Number(req.body.x)) ? Math.max(0, Math.round(Number(req.body.x))) : current.x,
    y: Number.isFinite(Number(req.body.y)) ? Math.max(0, Math.round(Number(req.body.y))) : current.y,
    caption: typeof req.body.caption === 'string' ? req.body.caption.trim().slice(0, 30) : current.caption,
    frameStyle: typeof req.body.frameStyle === 'string' ? cleanFrameStyle(req.body.frameStyle) : cleanFrameStyle(current.frame_style),
    frameColor: typeof req.body.frameColor === 'string' ? cleanFrameColor(req.body.frameColor) : cleanFrameColor(current.frame_color)
  };
  const result = db.prepare(`
    UPDATE magnets
    SET status = @status, x = @x, y = @y, caption = @caption, frame_style = @frameStyle, frame_color = @frameColor
    WHERE id = @id
  `).run(next);
  logAdmin('magnet:update', next);
  res.json({ ok: result.changes > 0 });
});

app.delete('/api/admin/magnets/:id', (req, res) => {
  const row = db.prepare('SELECT file_name AS fileName FROM magnets WHERE id = ?').get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Магнит не найден' });
    return;
  }
  db.prepare('DELETE FROM liked_magnets WHERE magnet_id = ?').run(req.params.id);
  db.prepare('DELETE FROM magnets WHERE id = ?').run(req.params.id);
  fs.unlink(path.join(MEMS_DIR, row.fileName), () => {});
  logAdmin('magnet:delete', { id: req.params.id, fileName: row.fileName });
  res.json({ ok: true });
});

app.delete('/api/admin/magnets', (req, res) => {
  if (req.body?.confirm !== 'УДАЛИТЬ ВСЕ') {
    res.status(400).json({ error: 'Для удаления всех магнитов введите: УДАЛИТЬ ВСЕ' });
    return;
  }

  const rows = db.prepare('SELECT id, file_name AS fileName FROM magnets').all();
  const removeAll = db.transaction(() => {
    db.prepare('DELETE FROM liked_magnets').run();
    db.prepare('DELETE FROM magnets').run();
  });
  removeAll();

  for (const row of rows) {
    fs.unlink(path.join(MEMS_DIR, row.fileName), () => {});
  }

  logAdmin('magnet:delete-all', { count: rows.length });
  res.json({ ok: true, count: rows.length });
});

app.get('/api/admin/logs', (_req, res) => {
  res.json(db.prepare('SELECT id, action, details, created_at AS createdAt FROM admin_logs ORDER BY id DESC LIMIT 80').all());
});

app.get('/adminka', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'adminka.html'));
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Ошибка запроса' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Holodilnik is running on http://localhost:${PORT}`);
  });
}

module.exports = app;
