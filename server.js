const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

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
const BACKUP_DIR = path.join(ROOT, 'backup_holodos');
const DB_PATH = path.join(DATA_DIR, 'holodilnik.sqlite');
const MAX_MAGNET_SIZE = 8 * 1024 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pass';
const ADMIN2_PASSWORD = process.env.ADMIN2_PASSWORD || 'admin2-pass';
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_LIMIT = 10;
const uploadHits = new Map();

fs.mkdirSync(MEMS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

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
    holder INTEGER NOT NULL DEFAULT 0,
    edit_token_hash TEXT,
    placement_locked INTEGER NOT NULL DEFAULT 1,
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
    admin_id TEXT,
    admin_name TEXT,
    ip TEXT,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    magnet_id TEXT NOT NULL,
    body TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
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
if (!magnetColumns.includes('edit_token_hash')) {
  db.exec("ALTER TABLE magnets ADD COLUMN edit_token_hash TEXT");
}
if (!magnetColumns.includes('placement_locked')) {
  db.exec("ALTER TABLE magnets ADD COLUMN placement_locked INTEGER NOT NULL DEFAULT 1");
}
if (!magnetColumns.includes('holder')) {
  db.exec("ALTER TABLE magnets ADD COLUMN holder INTEGER NOT NULL DEFAULT 0");
}

const logColumns = db.prepare('PRAGMA table_info(admin_logs)').all().map(column => column.name);
if (!logColumns.includes('admin_id')) {
  db.exec("ALTER TABLE admin_logs ADD COLUMN admin_id TEXT");
}
if (!logColumns.includes('admin_name')) {
  db.exec("ALTER TABLE admin_logs ADD COLUMN admin_name TEXT");
}
if (!logColumns.includes('ip')) {
  db.exec("ALTER TABLE admin_logs ADD COLUMN ip TEXT");
}

const insertAdmin = db.prepare('INSERT OR IGNORE INTO admins (id, display_name, password_hash) VALUES (?, ?, ?)');
insertAdmin.run('admin1', 'admin 1', ADMIN_PASSWORD.startsWith('$2') ? ADMIN_PASSWORD : bcrypt.hashSync(ADMIN_PASSWORD, 10));
insertAdmin.run('admin2', 'admin 2', ADMIN2_PASSWORD.startsWith('$2') ? ADMIN2_PASSWORD : bcrypt.hashSync(ADMIN2_PASSWORD, 10));

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('title_text', process.env.SITE_TITLE || 'Наш холодильник');
insertSetting.run('title_image', '');
insertSetting.run('moderation', 'false');
insertSetting.run('title_color', '#2a363b');
insertSetting.run('title_font', 'classic');
insertSetting.run('uploads_closed', 'false');
insertSetting.run('magnet_holders', 'true');

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function settings() {
  return {
    titleText: getSetting.get('title_text')?.value || 'Наш холодильник',
    titleImage: getSetting.get('title_image')?.value || '',
    moderation: getSetting.get('moderation')?.value === 'true',
    uploadsClosed: getSetting.get('uploads_closed')?.value === 'true',
    magnetHolders: getSetting.get('magnet_holders')?.value !== 'false',
    titleColor: getSetting.get('title_color')?.value || '#2a363b',
    titleFont: getSetting.get('title_font')?.value || 'classic'
  };
}

function isAdmin(req) {
  return Boolean(req.session?.adminId || req.session?.admin);
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket.remoteAddress || 'unknown';
}

function clientKey(req) {
  return clientIp(req);
}

function ipHash(req) {
  return crypto.createHash('sha256').update(String(clientKey(req))).digest('hex').slice(0, 20);
}

function cleanFrameStyle(value) {
  return ['polaroid', 'circle', 'mini'].includes(value) ? value : 'polaroid';
}

function cleanFrameColor(value) {
  return ['white', 'red', 'orange', 'yellow', 'green', 'blue'].includes(value) ? value : 'white';
}

function editTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function cleanCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function cleanColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#2a363b';
}

function cleanTitleFont(value) {
  return ['classic', 'hand', 'strict'].includes(value) ? value : 'classic';
}

function currentAdmin(req) {
  const id = req.session?.adminId || (req.session?.admin ? 'admin1' : null);
  if (!id) return null;
  return db.prepare('SELECT id, display_name AS displayName FROM admins WHERE id = ?').get(id) || null;
}

function logAdmin(action, details = {}, req = null) {
  const admin = req ? currentAdmin(req) : null;
  db.prepare('INSERT INTO admin_logs (action, admin_id, admin_name, ip, details) VALUES (?, ?, ?, ?, ?)')
    .run(action, admin?.id || null, admin?.displayName || null, req ? clientIp(req) : '', JSON.stringify(details));
  db.prepare(`
    DELETE FROM admin_logs
    WHERE id NOT IN (
      SELECT id FROM admin_logs ORDER BY id DESC LIMIT 500
    )
  `).run();
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

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function backupName() {
  return `holodilnik-${new Date().toISOString().replace(/[:.]/g, '-')}.holodos.json.gz`;
}

function safeBackupPath(name) {
  if (!/^[a-zA-Z0-9._-]+\.holodos\.json\.gz$/.test(String(name || ''))) return null;
  const full = path.resolve(BACKUP_DIR, name);
  return full.startsWith(path.resolve(BACKUP_DIR) + path.sep) ? full : null;
}

function listMemsFiles() {
  if (!fs.existsSync(MEMS_DIR)) return [];
  return fs.readdirSync(MEMS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name);
}

function exportManifest() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    tables: {
      settings: db.prepare('SELECT key, value FROM settings').all(),
      magnets: db.prepare('SELECT * FROM magnets ORDER BY created_at ASC').all(),
      liked_magnets: db.prepare('SELECT * FROM liked_magnets').all(),
      comments: db.prepare('SELECT * FROM comments ORDER BY id ASC').all(),
      admin_logs: db.prepare('SELECT * FROM admin_logs ORDER BY id ASC').all()
    },
    files: listMemsFiles().map(name => ({
      name,
      data: fs.readFileSync(path.join(MEMS_DIR, name)).toString('base64')
    }))
  };
}

function createBackupArchive() {
  const name = backupName();
  const target = path.join(BACKUP_DIR, name);
  fs.writeFileSync(target, zlib.gzipSync(Buffer.from(JSON.stringify(exportManifest()))));
  return { name, path: target, size: fs.statSync(target).size };
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => safeBackupPath(name))
    .map(name => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function restoreBackupArchive(name) {
  const source = safeBackupPath(name);
  if (!source || !fs.existsSync(source)) throw new Error('Бэкап не найден');
  const manifest = JSON.parse(zlib.gunzipSync(fs.readFileSync(source)).toString('utf8'));
  const tables = manifest.tables || {};

  const restore = db.transaction(() => {
    db.prepare('DELETE FROM liked_magnets').run();
    db.prepare('DELETE FROM comments').run();
    db.prepare('DELETE FROM magnets').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM admin_logs').run();

    for (const row of tables.settings || []) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(row.key, row.value);
    }
    for (const row of tables.magnets || []) {
      const magnetRow = {
        ...row,
        holder: typeof row.holder === 'number' ? row.holder : 0,
        edit_token_hash: row.edit_token_hash || null,
        placement_locked: typeof row.placement_locked === 'number' ? row.placement_locked : 1
      };
      db.prepare(`
        INSERT INTO magnets (id, file_name, original_name, caption, frame_style, frame_color, x, y, width, height, likes, status, holder, edit_token_hash, placement_locked, created_at)
        VALUES (@id, @file_name, @original_name, @caption, @frame_style, @frame_color, @x, @y, @width, @height, @likes, @status, @holder, @edit_token_hash, @placement_locked, @created_at)
      `).run(magnetRow);
    }
    for (const row of tables.liked_magnets || []) {
      db.prepare('INSERT INTO liked_magnets (magnet_id, voter_id, created_at) VALUES (@magnet_id, @voter_id, @created_at)').run(row);
    }
    for (const row of tables.comments || []) {
      db.prepare('INSERT INTO comments (id, magnet_id, body, ip, created_at) VALUES (@id, @magnet_id, @body, @ip, @created_at)').run(row);
    }
    for (const row of tables.admin_logs || []) {
      db.prepare('INSERT INTO admin_logs (id, action, admin_id, admin_name, ip, details, created_at) VALUES (@id, @action, @admin_id, @admin_name, @ip, @details, @created_at)').run(row);
    }
  });
  restore();

  fs.rmSync(MEMS_DIR, { recursive: true, force: true });
  fs.mkdirSync(MEMS_DIR, { recursive: true });
  for (const file of manifest.files || []) {
    const fileName = path.basename(String(file.name || ''));
    if (!fileName || fileName !== file.name) continue;
    fs.writeFileSync(path.join(MEMS_DIR, fileName), Buffer.from(String(file.data || ''), 'base64'));
  }
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
    SELECT
      id,
      file_name AS fileName,
      original_name AS originalName,
      caption,
      frame_style AS frameStyle,
      frame_color AS frameColor,
      x,
      y,
      width,
      height,
      likes,
      status,
      holder,
      created_at AS createdAt,
      (SELECT COUNT(*) FROM comments WHERE comments.magnet_id = magnets.id) AS commentCount
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
  if (settings().uploadsClosed && !isAdmin(req)) {
    rejectUpload(req.file, res, 'Холодильник закрыт для новых магнитов');
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
  const holder = cfg.magnetHolders && frameStyle !== 'mini' && Math.random() < 0.45 ? 1 : 0;
  const id = crypto.randomUUID();
  const editToken = crypto.randomUUID();
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
    status: cfg.moderation ? 'pending' : 'approved',
    holder,
    editTokenHash: cfg.moderation ? null : editTokenHash(editToken),
    placementLocked: cfg.moderation ? 1 : 0
  };

  db.prepare(`
    INSERT INTO magnets (id, file_name, original_name, caption, frame_style, frame_color, x, y, width, height, status, holder, edit_token_hash, placement_locked)
    VALUES (@id, @fileName, @originalName, @caption, @frameStyle, @frameColor, @x, @y, @width, @height, @status, @holder, @editTokenHash, @placementLocked)
  `).run(row);

  logAdmin('magnet:add', {
    id,
    fileName: row.fileName,
    frameStyle: row.frameStyle,
    frameColor: row.frameColor,
    holder: row.holder,
    status: row.status,
    ip: clientIp(req)
  }, req);

  const response = { ...row, src: `/mems/${row.fileName}` };
  delete response.editTokenHash;
  delete response.placementLocked;
  if (row.status === 'approved') response.editToken = editToken;
  res.status(201).json(response);
});

function editableMagnet(req, res) {
  const row = db.prepare(`
    SELECT id, file_name AS fileName, edit_token_hash AS editTokenHash, placement_locked AS placementLocked
    FROM magnets
    WHERE id = ? AND status = 'approved'
  `).get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Магнит не найден' });
    return null;
  }
  if (row.placementLocked || !row.editTokenHash || row.editTokenHash !== editTokenHash(req.body.editToken)) {
    res.status(403).json({ error: 'Магнит уже окончательно прилип' });
    return null;
  }
  return row;
}

app.patch('/api/magnets/:id/placement', (req, res) => {
  const row = editableMagnet(req, res);
  if (!row) return;
  const x = cleanCoordinate(req.body.x);
  const y = cleanCoordinate(req.body.y);
  if (x === null || y === null) {
    res.status(400).json({ error: 'Некорректная позиция магнита' });
    return;
  }
  db.prepare('UPDATE magnets SET x = ?, y = ? WHERE id = ?').run(x, y, req.params.id);
  logAdmin('magnet:reposition-once', { id: req.params.id, x, y, ip: clientIp(req) }, req);
  res.json({ ok: true, x, y });
});

app.delete('/api/magnets/:id/placement', (req, res) => {
  const row = editableMagnet(req, res);
  if (!row) return;
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM liked_magnets WHERE magnet_id = ?').run(req.params.id);
    db.prepare('DELETE FROM comments WHERE magnet_id = ?').run(req.params.id);
    db.prepare('DELETE FROM magnets WHERE id = ?').run(req.params.id);
  });
  remove();
  fs.unlink(path.join(MEMS_DIR, row.fileName), () => {});
  logAdmin('magnet:delete-before-stick', { id: req.params.id, fileName: row.fileName, ip: clientIp(req) }, req);
  res.json({ ok: true });
});

app.post('/api/magnets/:id/finalize', (req, res) => {
  const row = editableMagnet(req, res);
  if (!row) return;
  db.prepare('UPDATE magnets SET placement_locked = 1, edit_token_hash = NULL WHERE id = ?').run(req.params.id);
  logAdmin('magnet:finalize', { id: req.params.id, ip: clientIp(req) }, req);
  res.json({ ok: true });
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

app.get('/api/magnets/:id/comments', (req, res) => {
  const magnet = db.prepare("SELECT id FROM magnets WHERE id = ? AND (status = 'approved' OR ? = 1)").get(req.params.id, isAdmin(req) ? 1 : 0);
  if (!magnet) {
    res.status(404).json({ error: 'Магнит не найден' });
    return;
  }
  const rows = db.prepare('SELECT id, body, created_at AS createdAt FROM comments WHERE magnet_id = ? ORDER BY id ASC LIMIT 300').all(req.params.id);
  res.json(rows);
});

app.post('/api/magnets/:id/comments', (req, res) => {
  const magnet = db.prepare("SELECT id FROM magnets WHERE id = ? AND status = 'approved'").get(req.params.id);
  if (!magnet) {
    res.status(404).json({ error: 'Магнит не найден' });
    return;
  }
  const body = String(req.body.body || '').trim().slice(0, 500);
  if (!body) {
    res.status(400).json({ error: 'Введите комментарий' });
    return;
  }
  const result = db.prepare('INSERT INTO comments (magnet_id, body, ip) VALUES (?, ?, ?)').run(req.params.id, body, clientIp(req));
  logAdmin('comment:add', { magnetId: req.params.id, commentId: result.lastInsertRowid, ip: clientIp(req) }, req);
  const row = db.prepare('SELECT id, body, created_at AS createdAt FROM comments WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

app.post('/api/admin/login', async (req, res) => {
  const pass = String(req.body.password || '');
  const admins = db.prepare('SELECT id, display_name AS displayName, password_hash AS passwordHash FROM admins ORDER BY id ASC').all();
  let matched = null;
  for (const admin of admins) {
    if (await bcrypt.compare(pass, admin.passwordHash)) {
      matched = admin;
      break;
    }
  }
  if (!matched) {
    res.status(401).json({ error: 'Неверный пароль' });
    return;
  }
  req.session.adminId = matched.id;
  req.session.admin = true;
  logAdmin('login', {}, req);
  res.json({ ok: true, admin: { id: matched.id, displayName: matched.displayName } });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  const admin = currentAdmin(req);
  res.json({ admin: Boolean(admin), id: admin?.id || null, displayName: admin?.displayName || '' });
});

app.use('/api/admin', (req, res, next) => {
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'Нужен вход администратора' });
    return;
  }
  next();
});

app.patch('/api/admin/profile', async (req, res) => {
  const admin = currentAdmin(req);
  if (!admin) {
    res.status(401).json({ error: 'Нужен вход администратора' });
    return;
  }

  const displayName = typeof req.body.displayName === 'string'
    ? req.body.displayName.trim().slice(0, 40)
    : admin.displayName;
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const row = db.prepare('SELECT password_hash AS passwordHash FROM admins WHERE id = ?').get(admin.id);

  if (newPassword) {
    if (newPassword.length < 6) {
      res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });
      return;
    }
    if (!await bcrypt.compare(currentPassword, row.passwordHash)) {
      res.status(400).json({ error: 'Текущий пароль неверный' });
      return;
    }
    db.prepare('UPDATE admins SET display_name = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(displayName || admin.displayName, bcrypt.hashSync(newPassword, 10), admin.id);
  } else {
    db.prepare('UPDATE admins SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(displayName || admin.displayName, admin.id);
  }

  const updated = currentAdmin(req);
  logAdmin('admin:profile-update', { displayName: updated.displayName, passwordChanged: Boolean(newPassword) }, req);
  res.json({ ok: true, admin: updated });
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
  if (typeof req.body.uploadsClosed === 'string') {
    setSetting.run('uploads_closed', req.body.uploadsClosed === 'true' ? 'true' : 'false');
  }
  if (typeof req.body.magnetHolders === 'string') {
    setSetting.run('magnet_holders', req.body.magnetHolders === 'true' ? 'true' : 'false');
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
  logAdmin('settings:update', cfg, req);
  res.json(cfg);
});

app.get('/api/admin/storage', (_req, res) => {
  const bytes = dirSize(MEMS_DIR);
  res.json({
    memsBytes: bytes,
    memsMb: Math.round(bytes / 1024 / 1024 * 10) / 10,
    limitBytes: 1024 * 1024 * 1024,
    overLimit: bytes > 1024 * 1024 * 1024,
    uploadsClosed: settings().uploadsClosed
  });
});

app.post('/api/admin/close-fridge', (req, res) => {
  setSetting.run('uploads_closed', 'true');
  logAdmin('fridge:close', {}, req);
  res.json(settings());
});

app.post('/api/admin/open-fridge', (req, res) => {
  setSetting.run('uploads_closed', 'false');
  logAdmin('fridge:open', {}, req);
  res.json(settings());
});

app.get('/api/admin/backups', (_req, res) => {
  res.json(listBackups());
});

app.post('/api/admin/backups', (req, res) => {
  try {
    const backup = createBackupArchive();
    logAdmin('backup:create', backup, req);
    res.status(201).json(backup);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Не удалось создать бэкап' });
  }
});

app.post('/api/admin/backups/restore', (req, res) => {
  const name = String(req.body.name || '');
  if (req.body.confirm !== 'ВОССТАНОВИТЬ') {
    res.status(400).json({ error: 'Для восстановления введите: ВОССТАНОВИТЬ' });
    return;
  }
  try {
    restoreBackupArchive(name);
    logAdmin('backup:restore', { name }, req);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Не удалось восстановить бэкап' });
  }
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
  logAdmin('magnet:update', next, req);
  res.json({ ok: result.changes > 0 });
});

app.delete('/api/admin/magnets/:id', (req, res) => {
  const row = db.prepare('SELECT file_name AS fileName FROM magnets WHERE id = ?').get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Магнит не найден' });
    return;
  }
  db.prepare('DELETE FROM liked_magnets WHERE magnet_id = ?').run(req.params.id);
  db.prepare('DELETE FROM comments WHERE magnet_id = ?').run(req.params.id);
  db.prepare('DELETE FROM magnets WHERE id = ?').run(req.params.id);
  fs.unlink(path.join(MEMS_DIR, row.fileName), () => {});
  logAdmin('magnet:delete', { id: req.params.id, fileName: row.fileName }, req);
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
    db.prepare('DELETE FROM comments').run();
    db.prepare('DELETE FROM magnets').run();
  });
  removeAll();

  for (const row of rows) {
    fs.unlink(path.join(MEMS_DIR, row.fileName), () => {});
  }

  logAdmin('magnet:delete-all', { count: rows.length }, req);
  res.json({ ok: true, count: rows.length });
});

app.get('/api/admin/logs', (_req, res) => {
  res.json(db.prepare('SELECT id, action, admin_id AS adminId, admin_name AS adminName, ip, details, created_at AS createdAt FROM admin_logs ORDER BY id DESC LIMIT 80').all());
});

app.delete('/api/admin/logs', (req, res) => {
  if (req.body?.confirm !== 'ОЧИСТИТЬ ЖУРНАЛ') {
    res.status(400).json({ error: 'Для очистки журнала введите: ОЧИСТИТЬ ЖУРНАЛ' });
    return;
  }
  const result = db.prepare('DELETE FROM admin_logs').run();
  logAdmin('logs:clear', { deleted: result.changes }, req);
  res.json({ ok: true, deleted: result.changes });
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
