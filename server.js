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

fs.mkdirSync(MEMS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS magnets (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    original_name TEXT,
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
`);

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('title_text', process.env.SITE_TITLE || 'Наш холодильник');
insertSetting.run('title_image', '');
insertSetting.run('moderation', 'false');

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function settings() {
  return {
    titleText: getSetting.get('title_text')?.value || 'Наш холодильник',
    titleImage: getSetting.get('title_image')?.value || '',
    moderation: getSetting.get('moderation')?.value === 'true'
  };
}

function isAdmin(req) {
  return Boolean(req.session?.admin);
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
    secure: process.env.NODE_ENV === 'production',
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
      secure: process.env.NODE_ENV === 'production',
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
    SELECT id, file_name AS fileName, original_name AS originalName, x, y, width, height, likes, status, created_at AS createdAt
    FROM magnets
    WHERE ${includePending ? '1 = 1' : "status = 'approved'"}
    ORDER BY created_at ASC
  `).all();
  res.json(rows.map(row => ({ ...row, src: `/mems/${row.fileName}` })));
});

app.post('/api/magnets', upload.single('magnet'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Добавьте картинку магнита' });
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
  const id = crypto.randomUUID();
  const row = {
    id,
    fileName: req.file.filename,
    originalName: req.file.originalname,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.min(Math.max(Number(req.body.width) || 160, 80), 360),
    height: Math.min(Math.max(Number(req.body.height) || 160, 80), 360),
    likes: 0,
    status: cfg.moderation ? 'pending' : 'approved'
  };

  db.prepare(`
    INSERT INTO magnets (id, file_name, original_name, x, y, width, height, status)
    VALUES (@id, @fileName, @originalName, @x, @y, @width, @height, @status)
  `).run(row);

  res.status(201).json({ ...row, src: `/mems/${row.fileName}` });
});

app.post('/api/magnets/:id/like', (req, res) => {
  const voter = req.cookies.fridge_voter || crypto.randomUUID();
  const magnet = db.prepare("SELECT id, likes FROM magnets WHERE id = ? AND status = 'approved'").get(req.params.id);
  if (!magnet) {
    res.status(404).json({ error: 'Магнит не найден' });
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
  res.json(settings());
});

app.patch('/api/admin/magnets/:id', (req, res) => {
  const status = req.body.status === 'pending' ? 'pending' : 'approved';
  const result = db.prepare('UPDATE magnets SET status = ? WHERE id = ?').run(status, req.params.id);
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
  res.json({ ok: true });
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
