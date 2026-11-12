'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { buildBotReply } = require('./chatbot');

const dbPath = path.resolve(
  process.env.CHIMIC_DB_PATH || path.join(__dirname, '..', 'tavlik.db')
);

let database;
let initialization;

function persistDatabase(currentDatabase) {
  const directory = path.dirname(dbPath);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(currentDatabase.export()));
}

function tableColumns(currentDatabase, tableName) {
  return currentDatabase
    .exec(`PRAGMA table_info(${tableName})`)[0]
    ?.values.map((row) => row[1]) || [];
}

function addColumnIfMissing(currentDatabase, tableName, columnName, definition) {
  if (!tableColumns(currentDatabase, tableName).includes(columnName)) {
    currentDatabase.run(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`
    );
  }
}

async function initDatabase() {
  if (database) {
    return database;
  }
  if (initialization) {
    return initialization;
  }

  initialization = (async () => {
    const SQL = await initSqlJs();
    const currentDatabase = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();

    currentDatabase.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fullName TEXT NOT NULL,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        passwordHash TEXT NOT NULL,
        avatar TEXT,
        status TEXT DEFAULT 'Available now'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        tokenHash TEXT UNIQUE NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        senderId INTEGER NOT NULL,
        recipientId INTEGER NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'text',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        mediaId INTEGER
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        contactId INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(userId, contactId)
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerId INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        isPrivate INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS room_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roomId INTEGER NOT NULL,
        userId INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        joinedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(roomId, userId)
      );
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerId INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        isPrivate INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        groupId INTEGER NOT NULL,
        userId INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        joinedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(groupId, userId)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        type TEXT DEFAULT 'info',
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        readAt TEXT,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER UNIQUE NOT NULL,
        theme TEXT DEFAULT 'midnight',
        language TEXT DEFAULT 'en',
        aiConsent INTEGER DEFAULT 1,
        notificationsEnabled INTEGER DEFAULT 1,
        liveTranslation INTEGER DEFAULT 0,
        voiceAssistant INTEGER DEFAULT 0,
        wallpaper TEXT DEFAULT '',
        accent TEXT DEFAULT '#3478F6',
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        caption TEXT DEFAULT '',
        mediaUrl TEXT,
        type TEXT DEFAULT 'image',
        visibility TEXT DEFAULT 'friends',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        caption TEXT DEFAULT '',
        type TEXT DEFAULT 'text',
        mediaIds TEXT DEFAULT '[]',
        linkUrl TEXT DEFAULT '',
        visibility TEXT DEFAULT 'contacts',
        excludedUserIds TEXT DEFAULT '[]',
        includedUserIds TEXT DEFAULT '[]',
        expiresAt TEXT,
        saved INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerId INTEGER NOT NULL,
        recipientId INTEGER,
        purpose TEXT NOT NULL,
        originalName TEXT NOT NULL,
        storageName TEXT UNIQUE NOT NULL,
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        statusId INTEGER,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS status_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        statusId INTEGER NOT NULL,
        viewerId INTEGER NOT NULL,
        viewedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(statusId, viewerId)
      );
      CREATE TABLE IF NOT EXISTS status_reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        statusId INTEGER NOT NULL,
        userId INTEGER NOT NULL,
        reaction TEXT NOT NULL,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(statusId, userId)
      );
    `);

    addColumnIfMissing(currentDatabase, 'messages', 'mediaId', 'INTEGER');
    addColumnIfMissing(currentDatabase, 'user_settings', 'wallpaper', "TEXT DEFAULT ''");
    addColumnIfMissing(currentDatabase, 'user_settings', 'accent', "TEXT DEFAULT '#3478F6'");
    addColumnIfMissing(currentDatabase, 'statuses', 'caption', "TEXT DEFAULT ''");
    addColumnIfMissing(currentDatabase, 'statuses', 'type', "TEXT DEFAULT 'text'");
    addColumnIfMissing(currentDatabase, 'statuses', 'mediaIds', "TEXT DEFAULT '[]'");
    addColumnIfMissing(currentDatabase, 'statuses', 'linkUrl', "TEXT DEFAULT ''");
    addColumnIfMissing(currentDatabase, 'statuses', 'visibility', "TEXT DEFAULT 'contacts'");
    addColumnIfMissing(currentDatabase, 'statuses', 'excludedUserIds', "TEXT DEFAULT '[]'");
    addColumnIfMissing(currentDatabase, 'statuses', 'includedUserIds', "TEXT DEFAULT '[]'");
    addColumnIfMissing(currentDatabase, 'statuses', 'expiresAt', 'TEXT');
    addColumnIfMissing(currentDatabase, 'statuses', 'saved', 'INTEGER DEFAULT 0');
    addColumnIfMissing(currentDatabase, 'media', 'statusId', 'INTEGER');

    currentDatabase.run('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(senderId, recipientId, id)');
    currentDatabase.run('CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(userId, contactId, status)');
    currentDatabase.run('CREATE INDEX IF NOT EXISTS idx_media_status ON media(statusId)');
    persistDatabase(currentDatabase);
    database = currentDatabase;
    return database;
  })();

  try {
    return await initialization;
  } catch (error) {
    initialization = undefined;
    throw error;
  }
}

async function ensureDatabase() {
  return database || initDatabase();
}

async function get(sql, params = []) {
  const currentDatabase = await ensureDatabase();
  const statement = currentDatabase.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : undefined;
  } finally {
    statement.free();
  }
}

async function all(sql, params = []) {
  const currentDatabase = await ensureDatabase();
  const statement = currentDatabase.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

async function run(sql, params = []) {
  const currentDatabase = await ensureDatabase();
  currentDatabase.run(sql, params);
  const result = {
    changes: currentDatabase.getRowsModified(),
    id: currentDatabase.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0],
  };
  persistDatabase(currentDatabase);
  return result;
}

function hashPassword(password) {
  return crypto.createHash('sha512').update(String(password)).digest('hex');
}

function sanitizeUser(user) {
  if (!user) return user;
  const { passwordHash, passwordSalt, ...safeUser } = user;
  return safeUser;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  const parsed = JSON.parse(value || '[]');
  if (!Array.isArray(parsed)) {
    throw new Error('Stored list data is invalid.');
  }
  return parsed;
}

function mapStatus(row) {
  if (!row) return row;
  return {
    ...row,
    mediaIds: parseJsonArray(row.mediaIds),
    excludedUserIds: parseJsonArray(row.excludedUserIds),
    includedUserIds: parseJsonArray(row.includedUserIds),
    saved: Boolean(row.saved),
  };
}

function isExpired(status) {
  return status.expiresAt && Date.parse(`${String(status.expiresAt).replace(' ', 'T')}Z`) <= Date.now();
}

async function createUser({ fullName, username, email, password, avatar = null }) {
  const normalizedName = String(fullName || '').trim();
  const normalizedUsername = String(username || '').trim();
  const normalizedEmail = String(email || '').trim();

  if (!normalizedName || !normalizedUsername || !normalizedEmail || !password) {
    throw new Error('All required fields are required.');
  }
  if (String(password).length < 6) {
    throw new Error('Password must contain at least 6 characters.');
  }

  const existing = await get(
    'SELECT id FROM users WHERE username = ? OR email = ?',
    [normalizedUsername, normalizedEmail]
  );
  if (existing) {
    throw new Error('A user with that username or email already exists.');
  }

  const result = await run(
    `INSERT INTO users (fullName, username, email, passwordHash, avatar, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      normalizedName,
      normalizedUsername,
      normalizedEmail,
      hashPassword(password),
      avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(normalizedName)}&background=00a884&color=fff`,
      'Available now',
    ]
  );
  const createdUser = await get('SELECT * FROM users WHERE id = ?', [result.id]);
  await upsertUserSettings({ userId: createdUser.id });
  return createdUser;
}

async function findUserByCredentials(identifier, password) {
  if (!identifier || !password) return null;
  const user = await get(
    'SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE',
    [String(identifier).trim(), String(identifier).trim()]
  );
  if (!user || !crypto.timingSafeEqual(
    Buffer.from(user.passwordHash, 'hex'),
    Buffer.from(hashPassword(password), 'hex')
  )) {
    return null;
  }
  return user;
}

async function createSession(userId) {
  const user = await get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('User not found.');
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await run(
    'INSERT INTO sessions (userId, tokenHash, expiresAt) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
  return token;
}

async function getSessionUser(token) {
  if (typeof token !== 'string' || !token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await get(
    `SELECT users.* FROM sessions
     JOIN users ON users.id = sessions.userId
     WHERE sessions.tokenHash = ? AND sessions.expiresAt > datetime('now')`,
    [tokenHash]
  );
  return row || null;
}

async function revokeSession(token) {
  if (!token) return;
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  await run('DELETE FROM sessions WHERE tokenHash = ?', [tokenHash]);
}

async function getUsers() {
  return all('SELECT * FROM users ORDER BY id');
}

async function searchUsers(query) {
  const search = String(query || '').trim();
  if (!search) return [];
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  return all(
    `SELECT * FROM users
     WHERE username LIKE ? ESCAPE '\\'
        OR email LIKE ? ESCAPE '\\'
        OR fullName LIKE ? ESCAPE '\\'
     ORDER BY id`,
    [pattern, pattern, pattern]
  );
}

async function createMessage({ senderId, recipientId, content, type = 'text', mediaId = null }) {
  if (!String(content || '').trim()) throw new Error('Message content is required.');
  const result = await run(
    `INSERT INTO messages (senderId, recipientId, content, type, mediaId)
     VALUES (?, ?, ?, ?, ?)`,
    [senderId, recipientId, String(content), type, mediaId]
  );
  return get('SELECT * FROM messages WHERE id = ?', [result.id]);
}

async function getMessagesBetweenUsers(userA, userB) {
  return all(
    `SELECT * FROM messages
     WHERE (senderId = ? AND recipientId = ?)
        OR (senderId = ? AND recipientId = ?)
     ORDER BY id`,
    [userA, userB, userB, userA]
  );
}

async function createContactRequest({ userId, contactId }) {
  if (Number(userId) === Number(contactId)) throw new Error('You cannot add yourself.');
  const contact = await get('SELECT id FROM users WHERE id = ?', [contactId]);
  if (!contact) throw new Error('Contact not found.');
  const existing = await get(
    'SELECT * FROM contacts WHERE (userId = ? AND contactId = ?) OR (userId = ? AND contactId = ?)',
    [userId, contactId, contactId, userId]
  );
  if (existing?.status === 'accepted') throw new Error('These users are already contacts.');
  if (existing?.status === 'blocked') throw new Error('This contact is unavailable.');
  if (existing) throw new Error('A contact request already exists.');
  const result = await run(
    'INSERT INTO contacts (userId, contactId, status) VALUES (?, ?, ?)',
    [userId, contactId, 'pending']
  );
  return get('SELECT * FROM contacts WHERE id = ?', [result.id]);
}

async function acceptContactRequest({ userId, contactId }) {
  const request = await get(
    'SELECT * FROM contacts WHERE userId = ? AND contactId = ? AND status = ?',
    [contactId, userId, 'pending']
  );
  if (!request) throw new Error('Contact request not found.');
  await run('UPDATE contacts SET status = ? WHERE id = ?', ['accepted', request.id]);
  const reciprocal = await get(
    'SELECT id FROM contacts WHERE userId = ? AND contactId = ?',
    [userId, contactId]
  );
  if (reciprocal) {
    await run('UPDATE contacts SET status = ? WHERE id = ?', ['accepted', reciprocal.id]);
  } else {
    await run(
      'INSERT INTO contacts (userId, contactId, status) VALUES (?, ?, ?)',
      [userId, contactId, 'accepted']
    );
  }
  return get('SELECT * FROM contacts WHERE id = ?', [request.id]);
}

async function rejectContactRequest({ userId, contactId }) {
  const request = await get(
    'SELECT * FROM contacts WHERE userId = ? AND contactId = ? AND status = ?',
    [contactId, userId, 'pending']
  );
  if (!request) throw new Error('Contact request not found.');
  await run('DELETE FROM contacts WHERE id = ?', [request.id]);
  return { ...request, status: 'rejected' };
}

async function blockUser({ userId, contactId }) {
  if (Number(userId) === Number(contactId)) throw new Error('You cannot block yourself.');
  await run('DELETE FROM contacts WHERE (userId = ? AND contactId = ?) OR (userId = ? AND contactId = ?)', [userId, contactId, contactId, userId]);
  const result = await run(
    'INSERT INTO contacts (userId, contactId, status) VALUES (?, ?, ?)',
    [userId, contactId, 'blocked']
  );
  return get('SELECT * FROM contacts WHERE id = ?', [result.id]);
}

async function getContactsForUser(userId) {
  return all(
    `SELECT contacts.id, contacts.userId,
            CASE WHEN contacts.userId = ? THEN contacts.contactId ELSE contacts.userId END AS contactId,
            contacts.status, contacts.createdAt,
            users.fullName, users.username, users.email, users.avatar, users.status AS userStatus
     FROM contacts
     JOIN users ON users.id = CASE WHEN contacts.userId = ? THEN contacts.contactId ELSE contacts.userId END
     WHERE (contacts.userId = ? OR contacts.contactId = ?) AND contacts.status = 'accepted'
     ORDER BY users.fullName`,
    [userId, userId, userId, userId]
  );
}

async function getPendingContactRequests(userId) {
  return all(
    `SELECT contacts.*, users.fullName, users.username, users.avatar
     FROM contacts JOIN users ON users.id = contacts.userId
     WHERE contacts.contactId = ? AND contacts.status = 'pending'
     ORDER BY contacts.id DESC`,
    [userId]
  );
}

async function createRoom({ ownerId, name, description = '', isPrivate = false }) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) throw new Error('Room name is required.');
  const result = await run(
    'INSERT INTO rooms (ownerId, name, description, isPrivate) VALUES (?, ?, ?, ?)',
    [ownerId, normalizedName, String(description || '').trim(), isPrivate ? 1 : 0]
  );
  await run('INSERT INTO room_members (roomId, userId, role) VALUES (?, ?, ?)', [result.id, ownerId, 'owner']);
  return get('SELECT * FROM rooms WHERE id = ?', [result.id]);
}

async function getRoomsForUser(userId) {
  return all(
    `SELECT DISTINCT rooms.* FROM rooms
     LEFT JOIN room_members ON room_members.roomId = rooms.id
     WHERE rooms.isPrivate = 0 OR rooms.ownerId = ? OR room_members.userId = ?
     ORDER BY rooms.id DESC`,
    [userId, userId]
  );
}

async function joinRoom({ roomId, userId, role = 'member' }) {
  const room = await get('SELECT * FROM rooms WHERE id = ?', [roomId]);
  if (!room) throw new Error('Room not found.');
  if (room.isPrivate && Number(room.ownerId) !== Number(userId)) {
    throw new Error('This room is private.');
  }
  await run(
    `INSERT OR IGNORE INTO room_members (roomId, userId, role) VALUES (?, ?, ?)`,
    [roomId, userId, role]
  );
  return room;
}

async function createGroup({ ownerId, name, description = '', isPrivate = false }) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) throw new Error('Group name is required.');
  const result = await run(
    'INSERT INTO groups (ownerId, name, description, isPrivate) VALUES (?, ?, ?, ?)',
    [ownerId, normalizedName, String(description || '').trim(), isPrivate ? 1 : 0]
  );
  await run('INSERT INTO group_members (groupId, userId, role) VALUES (?, ?, ?)', [result.id, ownerId, 'owner']);
  return get('SELECT * FROM groups WHERE id = ?', [result.id]);
}

async function getGroupsForUser(userId) {
  return all(
    `SELECT DISTINCT groups.* FROM groups
     LEFT JOIN group_members ON group_members.groupId = groups.id
     WHERE groups.isPrivate = 0 OR groups.ownerId = ? OR group_members.userId = ?
     ORDER BY groups.id DESC`,
    [userId, userId]
  );
}

async function joinGroup({ groupId, userId, role = 'member' }) {
  const group = await get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) throw new Error('Group not found.');
  if (group.isPrivate && Number(group.ownerId) !== Number(userId)) {
    throw new Error('This group is private.');
  }
  await run(
    'INSERT OR IGNORE INTO group_members (groupId, userId, role) VALUES (?, ?, ?)',
    [groupId, userId, role]
  );
  return group;
}

async function createNotification({ userId, type = 'info', title, body }) {
  const normalizedTitle = String(title || '').trim();
  const normalizedBody = String(body || '').trim();
  if (!normalizedTitle || !normalizedBody) throw new Error('Notification title and body are required.');
  const result = await run(
    'INSERT INTO notifications (userId, type, title, body) VALUES (?, ?, ?, ?)',
    [userId, String(type || 'info'), normalizedTitle, normalizedBody]
  );
  return get('SELECT * FROM notifications WHERE id = ?', [result.id]);
}

async function getNotificationsForUser(userId) {
  return all('SELECT * FROM notifications WHERE userId = ? ORDER BY id DESC', [userId]);
}

async function upsertUserSettings({
  userId,
  theme = 'midnight',
  language = 'en',
  aiConsent = 1,
  notificationsEnabled = 1,
  liveTranslation = 0,
  voiceAssistant = 0,
  wallpaper = '',
  accent = '#3478F6',
}) {
  const user = await get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('User not found.');
  await run(
    `INSERT INTO user_settings
       (userId, theme, language, aiConsent, notificationsEnabled, liveTranslation, voiceAssistant, wallpaper, accent, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(userId) DO UPDATE SET
       theme = excluded.theme, language = excluded.language, aiConsent = excluded.aiConsent,
       notificationsEnabled = excluded.notificationsEnabled, liveTranslation = excluded.liveTranslation,
       voiceAssistant = excluded.voiceAssistant, wallpaper = excluded.wallpaper,
       accent = excluded.accent, updatedAt = CURRENT_TIMESTAMP`,
    [userId, theme, language, Number(Boolean(aiConsent)), Number(Boolean(notificationsEnabled)), Number(Boolean(liveTranslation)), Number(Boolean(voiceAssistant)), wallpaper, accent]
  );
  return getUserSettings(userId);
}

async function getUserSettings(userId) {
  const settings = await get('SELECT * FROM user_settings WHERE userId = ?', [userId]);
  if (settings) return settings;
  return {
    userId: Number(userId),
    theme: 'midnight',
    language: 'en',
    aiConsent: 1,
    notificationsEnabled: 1,
    liveTranslation: 0,
    voiceAssistant: 0,
    wallpaper: '',
    accent: '#3478F6',
  };
}

function generateAiAssistantReply(message) {
  const text = String(message || '').trim();
  if (/\b(price|pricing|plan|plans)\b/i.test(text)) {
    return 'Here is a polite reply about pricing: Thank you for asking! I would be happy to share the available plans and help you find the right option.';
  }
  return buildBotReply(text);
}

async function createStory({ userId, caption = '', mediaUrl = null, type = 'image', visibility = 'friends' }) {
  if (!userId) throw new Error('A story owner is required.');
  const result = await run(
    'INSERT INTO stories (userId, caption, mediaUrl, type, visibility) VALUES (?, ?, ?, ?, ?)',
    [userId, String(caption || '').trim(), mediaUrl, type, visibility]
  );
  return get('SELECT * FROM stories WHERE id = ?', [result.id]);
}

async function getStoriesForUser(userId) {
  return all(
    `SELECT stories.*, users.fullName, users.username, users.avatar
     FROM stories JOIN users ON users.id = stories.userId
     WHERE stories.userId = ? OR stories.visibility IN ('public', 'all')
        OR (stories.visibility IN ('friends', 'contacts') AND EXISTS (
          SELECT 1 FROM contacts
          WHERE contacts.status = 'accepted'
            AND ((contacts.userId = stories.userId AND contacts.contactId = ?)
              OR (contacts.userId = ? AND contacts.contactId = stories.userId))
        ))
     ORDER BY stories.id DESC`,
    [userId, userId, userId]
  );
}

async function createMedia({ ownerId, recipientId = null, purpose, originalName, storageName, mimeType, size }) {
  if (!['message', 'status'].includes(purpose)) throw new Error('Invalid media purpose.');
  const result = await run(
    `INSERT INTO media (ownerId, recipientId, purpose, originalName, storageName, mimeType, size)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ownerId, recipientId, purpose, originalName, storageName, mimeType, size]
  );
  return getMedia(result.id);
}

async function getMedia(mediaId) {
  return get('SELECT * FROM media WHERE id = ?', [mediaId]);
}

async function createStatus({
  userId,
  content = '',
  caption = '',
  type = 'text',
  mediaIds = [],
  linkUrl = '',
  visibility = 'contacts',
  excludedUserIds = [],
  includedUserIds = [],
  saved = false,
}) {
  if (!Array.isArray(mediaIds) || !Array.isArray(excludedUserIds) || !Array.isArray(includedUserIds)) {
    throw new Error('Status audience and media selections must be lists.');
  }
  const allowedVisibility = ['public', 'all', 'contacts', 'friends', 'selected', 'private'];
  if (!allowedVisibility.includes(visibility)) throw new Error('Invalid status visibility.');
  const statusText = String(content || caption || '').trim();
  if (!statusText && !mediaIds.length && !String(linkUrl || '').trim()) {
    throw new Error('A status needs text, a link, or media.');
  }

  const expiration = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const result = await run(
    `INSERT INTO statuses
       (userId, content, caption, type, mediaIds, linkUrl, visibility, excludedUserIds, includedUserIds, expiresAt, saved)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      statusText,
      String(caption || '').trim(),
      type || 'text',
      JSON.stringify(mediaIds),
      String(linkUrl || ''),
      visibility,
      JSON.stringify(excludedUserIds),
      JSON.stringify(includedUserIds),
      expiration,
      Number(Boolean(saved)),
    ]
  );
  for (const mediaId of mediaIds) {
    await run('UPDATE media SET statusId = ? WHERE id = ? AND ownerId = ? AND purpose = ?', [result.id, mediaId, userId, 'status']);
  }
  return mapStatus(await get('SELECT * FROM statuses WHERE id = ?', [result.id]));
}

async function getStatus(statusId) {
  const row = await get('SELECT * FROM statuses WHERE id = ?', [statusId]);
  return mapStatus(row);
}

async function isContact(userId, otherUserId) {
  return Boolean(await get(
    `SELECT id FROM contacts WHERE status = 'accepted'
     AND ((userId = ? AND contactId = ?) OR (userId = ? AND contactId = ?))`,
    [userId, otherUserId, otherUserId, userId]
  ));
}

async function canViewStatus(status, viewerId) {
  if (!status || isExpired(status)) return false;
  if (Number(status.userId) === Number(viewerId)) return true;
  const excluded = parseJsonArray(status.excludedUserIds).map(Number);
  if (excluded.includes(Number(viewerId))) return false;
  const visibility = status.visibility || 'contacts';
  if (visibility === 'private') return false;
  if (visibility === 'selected') {
    return parseJsonArray(status.includedUserIds).map(Number).includes(Number(viewerId));
  }
  if (visibility === 'public' || visibility === 'all') return true;
  return isContact(status.userId, viewerId);
}

async function getStatuses(viewerId) {
  const rows = await all(
    `SELECT statuses.*, users.fullName, users.username, users.avatar
     FROM statuses JOIN users ON users.id = statuses.userId
     WHERE statuses.expiresAt IS NULL OR statuses.expiresAt > datetime('now')
     ORDER BY statuses.id DESC`
  );
  const visible = [];
  for (const row of rows) {
    const status = mapStatus(row);
    if (await canViewStatus(status, viewerId)) visible.push(status);
  }
  return visible;
}

async function recordStatusView(statusId, viewerId) {
  const status = await getStatus(statusId);
  if (!status || !(await canViewStatus(status, viewerId))) {
    throw new Error('This status is unavailable.');
  }
  await run(
    `INSERT INTO status_views (statusId, viewerId) VALUES (?, ?)
     ON CONFLICT(statusId, viewerId) DO UPDATE SET viewedAt = CURRENT_TIMESTAMP`,
    [statusId, viewerId]
  );
  return get('SELECT * FROM status_views WHERE statusId = ? AND viewerId = ?', [statusId, viewerId]);
}

async function getStatusViewers(statusId, requesterId) {
  const status = await getStatus(statusId);
  if (!status || Number(status.userId) !== Number(requesterId) || isExpired(status)) {
    throw new Error('Status not found.');
  }
  return all(
    `SELECT status_views.*, users.fullName, users.username, users.avatar
     FROM status_views JOIN users ON users.id = status_views.viewerId
     WHERE status_views.statusId = ? ORDER BY status_views.viewedAt DESC`,
    [statusId]
  );
}

async function addStatusReaction(statusId, userId, reaction) {
  const status = await getStatus(statusId);
  if (!status || !(await canViewStatus(status, userId))) {
    throw new Error('This status is unavailable.');
  }
  await run(
    `INSERT INTO status_reactions (statusId, userId, reaction) VALUES (?, ?, ?)
     ON CONFLICT(statusId, userId) DO UPDATE SET reaction = excluded.reaction, createdAt = CURRENT_TIMESTAMP`,
    [statusId, userId, reaction]
  );
  return get('SELECT * FROM status_reactions WHERE statusId = ? AND userId = ?', [statusId, userId]);
}

async function deleteStatus(statusId, userId) {
  const status = await getStatus(statusId);
  if (!status || Number(status.userId) !== Number(userId)) {
    throw new Error('Status not found.');
  }
  const media = await all('SELECT * FROM media WHERE statusId = ?', [statusId]);
  await run('DELETE FROM status_views WHERE statusId = ?', [statusId]);
  await run('DELETE FROM status_reactions WHERE statusId = ?', [statusId]);
  await run('DELETE FROM media WHERE statusId = ?', [statusId]);
  await run('DELETE FROM statuses WHERE id = ?', [statusId]);
  return media;
}

module.exports = {
  initDatabase,
  db: { get: ensureDatabase },
  sanitizeUser,
  createUser,
  findUserByCredentials,
  createSession,
  getSessionUser,
  revokeSession,
  getUsers,
  searchUsers,
  createMessage,
  getMessagesBetweenUsers,
  createContactRequest,
  acceptContactRequest,
  rejectContactRequest,
  blockUser,
  getContactsForUser,
  getPendingContactRequests,
  createRoom,
  getRoomsForUser,
  joinRoom,
  createGroup,
  getGroupsForUser,
  joinGroup,
  createNotification,
  getNotificationsForUser,
  upsertUserSettings,
  getUserSettings,
  generateAiAssistantReply,
  createStory,
  getStoriesForUser,
  createMedia,
  getMedia,
  createStatus,
  getStatus,
  getStatuses,
  canViewStatus,
  recordStatusView,
  getStatusViewers,
  addStatusReaction,
  deleteStatus,
};
