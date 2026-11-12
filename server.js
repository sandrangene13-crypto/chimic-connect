
'use strict';

require('dotenv').config();

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');

const { isBotUser } = require('./src/chatbot');

const {
  initDatabase,
  createUser,
  findUserByCredentials,
  createSession,
  getSessionUser,
  revokeSession,
  getUsers,
  searchUsers,
  createMedia,
  getMedia,
  createMessage,
  getMessagesBetweenUsers,
  createStatus,
  getStatus,
  getStatuses,
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
  createStory,
  getStoriesForUser,
  canViewStatus,
  recordStatusView,
  getStatusViewers,
  addStatusReaction,
  deleteStatus,
} = require('./src/tavlik-core');

// ==================================================
// CONFIGURATION
// ==================================================

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;

const OPENAI_MODEL =
  process.env.OPENAI_MODEL || 'gpt-6-luna';

const OPENAI_URL =
  'https://api.openai.com/v1/responses';

app.set('trust proxy', 1);

const allowedOrigins = new Set(
  (
    process.env.CHIMIC_ALLOWED_ORIGINS ||
    `http://localhost:${PORT},http://127.0.0.1:${PORT}`
  )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed.'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-File-Name',
    'X-File-Content-Type',
    'X-Media-Purpose',
    'X-Recipient-Id',
  ],
};

const io = new Server(server, {
  cors: corsOptions,
});

const MEDIA_DIRECTORY = path.resolve(
  process.env.CHIMIC_MEDIA_DIR ||
  process.env.TAVLIK_MEDIA_DIR ||
  path.join(__dirname, '..', 'tavlik-media')
);

// ==================================================
// RATE LIMITERS
// ==================================================

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const authenticationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Try again later.',
  },
});

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many AI requests. Please try again later.',
  },
});

// ==================================================
// MIDDLEWARE
// ==================================================

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(cors(corsOptions));

app.use(express.json({
  limit: '20mb',
}));

app.use('/api', apiLimiter);

// ==================================================
// GENERAL HELPERS
// ==================================================

function sanitizeUser(user) {
  if (!user) return null;

  const {
    passwordHash,
    passwordSalt,
    ...safeUser
  } = user;

  return safeUser;
}

function getBearerToken(req) {
  const authorization =
    req.get('authorization') || '';

  return authorization
    .replace(/^Bearer\s+/i, '')
    .trim();
}

function validId(value) {
  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

function safeDownloadName(value) {
  const name = path
    .basename(String(value || 'download'))
    .replace(/[\r\n\\/\u0000-\u001f]/g, '_')
    .trim();

  return name || 'download';
}

function decodeFileName(value) {
  try {
    return decodeURIComponent(
      String(value || 'attachment')
    );
  } catch {
    return 'attachment';
  }
}

function safeMediaPath(storageName) {
  const filePath = path.resolve(
    MEDIA_DIRECTORY,
    String(storageName || '')
  );

  const relative = path.relative(
    MEDIA_DIRECTORY,
    filePath
  );

  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Invalid media storage path.');
  }

  return filePath;
}

function canInlineMedia(mimeType) {
  return /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(webm|mp4|ogg|mpeg|wav|aac)|application\/pdf)$/i.test(
    String(mimeType || '')
  );
}

function isDangerousFileName(name) {
  return /\.(html?|xhtml|svg|js|mjs|cjs|exe|dll|bat|cmd|ps1|sh|php|jar|apk|msi|com|scr)$/i.test(
    String(name || '')
  );
}

function validMediaSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }

  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 5).toString() === '%PDF-';
  }

  if (mimeType === 'image/png') {
    return buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
  }

  if (mimeType === 'image/jpeg') {
    return (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  if (mimeType === 'image/gif') {
    return ['GIF87a', 'GIF89a'].includes(
      buffer.subarray(0, 6).toString()
    );
  }

  if (mimeType === 'image/webp') {
    return (
      buffer.subarray(0, 4).toString() === 'RIFF' &&
      buffer.subarray(8, 12).toString() === 'WEBP'
    );
  }

  if (mimeType === 'image/avif') {
    return (
      buffer.subarray(4, 8).toString() === 'ftyp' &&
      ['avif', 'avis'].includes(
        buffer.subarray(8, 12).toString()
      )
    );
  }

  if (
    mimeType === 'video/mp4' ||
    mimeType === 'audio/mp4' ||
    mimeType === 'video/quicktime'
  ) {
    return buffer.subarray(4, 8).toString() === 'ftyp';
  }

  if (
    mimeType === 'video/webm' ||
    mimeType === 'audio/webm'
  ) {
    return buffer.subarray(0, 4).equals(
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
    );
  }

  if (mimeType === 'audio/ogg') {
    return buffer.subarray(0, 4).toString() === 'OggS';
  }

  if (
    mimeType === 'audio/wav' ||
    mimeType === 'audio/x-wav'
  ) {
    return (
      buffer.subarray(0, 4).toString() === 'RIFF' &&
      buffer.subarray(8, 12).toString() === 'WAVE'
    );
  }

  if (mimeType === 'audio/mpeg') {
    return (
      buffer.subarray(0, 3).toString() === 'ID3' ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
    );
  }

  if (mimeType === 'audio/aac') {
    return (
      buffer[0] === 0xff &&
      (buffer[1] & 0xf6) === 0xf0
    );
  }

  // Generic attachments are download-only.
  if (mimeType === 'application/octet-stream') {
    return true;
  }

  return false;
}

function emitToUser(userId, event, payload) {
  if (!validId(userId)) return;

  io.to(`user-${Number(userId)}`).emit(event, payload);
}

function emitMessage(message) {
  if (!message) return;

  emitToUser(message.senderId, 'message:new', message);
  emitToUser(message.recipientId, 'message:new', message);
}

function apiError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

// ==================================================
// AUTHENTICATION MIDDLEWARE
// ==================================================

async function requireSession(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return apiError(
        res,
        401,
        'Please log in to continue.'
      );
    }

    const user = await getSessionUser(token);

    if (!user) {
      return apiError(
        res,
        401,
        'Your session has expired. Please log in again.'
      );
    }

    req.sessionUser = user;

    return next();
  } catch (error) {
    return next(error);
  }
}

// ==================================================
// WEBSITE FILES
// ==================================================

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/src/chatbot.js', (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'src', 'chatbot.js')
  );
});

app.get('/manifest.json', (_req, res) => {
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/sw.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/icon.svg', (_req, res) => {
  res.sendFile(path.join(__dirname, 'icon.svg'));
});

// Never expose private source or database files.
app.get(
  [
    '/tavlik.db',
    '/src/tavlik-core.js',
    '/package.json',
    '/README.md',
    '/server.js',
    '/.env',
  ],
  (_req, res) => {
    res.status(404).end();
  }
);

// ==================================================
// HEALTH CHECK
// ==================================================

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    status: 'ok',
    app: 'Chimic Connect',
    version: '2.1.0',
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
});

// ==================================================
// REGISTRATION
// ==================================================

async function registerHandler(req, res) {
  try {
    const {
      fullName,
      username,
      email,
      password,
    } = req.body || {};

    const user = await createUser({
      fullName,
      username,
      email,
      password,
    });

    const sessionToken = await createSession(user.id);

    return res.status(201).json({
      success: true,
      user: sanitizeUser(user),
      sessionToken,
    });
  } catch (error) {
    return apiError(
      res,
      400,
      error.message || 'Registration could not be completed.'
    );
  }
}

app.post(
  '/api/register',
  authenticationLimiter,
  registerHandler
);

app.post(
  '/api/auth/register',
  authenticationLimiter,
  registerHandler
);

// ==================================================
// LOGIN
// ==================================================

async function loginHandler(req, res) {
  try {
    const {
      identifier,
      username,
      email,
      password,
    } = req.body || {};

    const loginIdentifier =
      identifier || username || email;

    const user = await findUserByCredentials(
      loginIdentifier,
      password
    );

    if (!user) {
      return apiError(
        res,
        401,
        'Invalid username/email or password.'
      );
    }

    const sessionToken = await createSession(user.id);

    return res.json({
      success: true,
      user: sanitizeUser(user),
      sessionToken,
    });
  } catch (error) {
    return apiError(
      res,
      400,
      error.message || 'Login could not be completed.'
    );
  }
}

app.post(
  '/api/login',
  authenticationLimiter,
  loginHandler
);

app.post(
  '/api/auth/login',
  authenticationLimiter,
  loginHandler
);

// ==================================================
// CURRENT USER
// ==================================================

app.get('/api/session', requireSession, (req, res) => {
  res.json({
    success: true,
    user: sanitizeUser(req.sessionUser),
  });
});

app.get('/api/me', requireSession, (req, res) => {
  res.json({
    success: true,
    user: sanitizeUser(req.sessionUser),
  });
});

// ==================================================
// LOGOUT
// ==================================================

app.post('/api/logout', requireSession, async (req, res) => {
  try {
    await revokeSession(getBearerToken(req));

    return res.json({
      success: true,
      message: 'You have been logged out.',
    });
  } catch {
    return apiError(
      res,
      500,
      'Unable to end this session.'
    );
  }
});

// ==================================================
// USERS
// ==================================================

app.get('/api/users', requireSession, async (_req, res) => {
  try {
    const users = await getUsers();

    return res.json(
      users.map(sanitizeUser)
    );
  } catch {
    return apiError(
      res,
      500,
      'Unable to load users.'
    );
  }
});

// ==================================================
// USER SEARCH
// ==================================================

async function searchHandler(req, res) {
  try {
    const query = String(
      req.query.q || ''
    ).trim();

    if (query.length > 100) {
      return apiError(
        res,
        400,
        'Search text is too long.'
      );
    }

    const users = await searchUsers(query);

    return res.json(
      users.map(sanitizeUser)
    );
  } catch {
    return apiError(
      res,
      500,
      'Unable to search users.'
    );
  }
}

app.get('/api/search', requireSession, searchHandler);
app.get('/api/users/search', requireSession, searchHandler);

// ==================================================
// CONTACTS
// ==================================================

app.get('/api/contacts', requireSession, async (req, res) => {
  try {
    const contacts = await getContactsForUser(
      Number(req.sessionUser.id)
    );

    return res.json(contacts);
  } catch {
    return apiError(res, 500, 'Unable to load contacts.');
  }
});

app.get(
  '/api/contacts/requests',
  requireSession,
  async (req, res) => {
    try {
      const requests = await getPendingContactRequests(
        Number(req.sessionUser.id)
      );

      return res.json(requests);
    } catch {
      return apiError(
        res,
        500,
        'Unable to load contact requests.'
      );
    }
  }
);

app.post(
  '/api/contacts/request',
  requireSession,
  async (req, res) => {
    try {
      const contactId = validId(req.body?.contactId);
      const userId = Number(req.sessionUser.id);

      if (!contactId || contactId === userId) {
        return apiError(
          res,
          400,
          'Choose a valid contact.'
        );
      }

      const request = await createContactRequest({
        userId,
        contactId,
      });

      await createNotification({
        userId: contactId,
        type: 'contact_request',
        title: 'New contact request',
        body: 'Someone sent you a contact request on Chimic Connect.',
      });

      return res.status(201).json({
        success: true,
        request,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to send contact request.'
      );
    }
  }
);

app.post(
  '/api/contacts/accept',
  requireSession,
  async (req, res) => {
    try {
      const contactId = validId(req.body?.contactId);

      if (!contactId) {
        return apiError(res, 400, 'Choose a valid contact.');
      }

      const userId = Number(req.sessionUser.id);

      const contact = await acceptContactRequest({
        userId,
        contactId,
      });

      await createNotification({
        userId: contactId,
        type: 'contact_accepted',
        title: 'Contact request accepted',
        body: 'Your contact request was accepted.',
      });

      return res.json({
        success: true,
        contact,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to accept request.'
      );
    }
  }
);

app.post(
  '/api/contacts/reject',
  requireSession,
  async (req, res) => {
    try {
      const contactId = validId(req.body?.contactId);

      if (!contactId) {
        return apiError(res, 400, 'Choose a valid contact.');
      }

      const contact = await rejectContactRequest({
        userId: req.sessionUser.id,
        contactId,
      });

      return res.json({
        success: true,
        contact,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to reject request.'
      );
    }
  }
);

app.post(
  '/api/contacts/block',
  requireSession,
  async (req, res) => {
    try {
      const contactId = validId(req.body?.contactId);

      if (!contactId) {
        return apiError(res, 400, 'Choose a valid contact.');
      }

      const contact = await blockUser({
        userId: req.sessionUser.id,
        contactId,
      });

      return res.json({
        success: true,
        contact,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to block contact.'
      );
    }
  }
);

// ==================================================
// PRIVATE MESSAGES
// ==================================================

async function loadConversation(req, res, userBValue) {
  try {
    const userA = Number(req.sessionUser.id);
    const userB = validId(userBValue);

    if (!userB || userA === userB) {
      return apiError(
        res,
        400,
        'A valid conversation is required.'
      );
    }

    const messages = await getMessagesBetweenUsers(
      userA,
      userB
    );

    return res.json(messages);
  } catch {
    return apiError(
      res,
      500,
      'Unable to load this conversation.'
    );
  }
}

app.get(
  '/api/messages',
  requireSession,
  async (req, res) => {
    const userA = validId(req.query.userA);
    const sessionId = Number(req.sessionUser.id);

    if (userA !== sessionId) {
      return apiError(
        res,
        403,
        'You cannot read another user’s conversation.'
      );
    }

    return loadConversation(
      req,
      res,
      req.query.userB
    );
  }
);

// Compatibility with clients using /api/messages/:userId.
app.get(
  '/api/messages/:userId',
  requireSession,
  async (req, res) => {
    return loadConversation(
      req,
      res,
      req.params.userId
    );
  }
);

// ==================================================
// SEND PRIVATE MESSAGE
// ==================================================

app.post(
  '/api/messages',
  requireSession,
  async (req, res) => {
    try {
      const {
        senderId,
        recipientId,
        content,
        type = 'text',
        mediaId = null,
      } = req.body || {};

      const sender = validId(senderId);
      const recipient = validId(recipientId);
      const sessionId = Number(req.sessionUser.id);

      if (!sender || sender !== sessionId) {
        return apiError(
          res,
          403,
          'You can only send messages from your own account.'
        );
      }

      if (!recipient || recipient === sender) {
        return apiError(
          res,
          400,
          'Choose a valid conversation participant.'
        );
      }

      if (
        typeof content !== 'string' ||
        content.length > 20000
      ) {
        return apiError(
          res,
          400,
          'Message content is invalid or too long.'
        );
      }

      const validTypes = [
        'text',
        'image',
        'video',
        'audio',
        'voice',
        'file',
        'document',
        'sticker',
      ];

      if (!validTypes.includes(type)) {
        return apiError(
          res,
          400,
          'Unsupported message type.'
        );
      }

      const cleanContent = content.trim();

      if (!cleanContent && !mediaId) {
        return apiError(
          res,
          400,
          'Write a message or attach a file.'
        );
      }

      const recipientExists = (await getUsers()).some(
        user => Number(user.id) === recipient
      );

      if (!recipientExists) {
        return apiError(
          res,
          404,
          'Conversation participant not found.'
        );
      }

      if (mediaId) {
        const attachmentId = validId(mediaId);

        if (!attachmentId) {
          return apiError(
            res,
            400,
            'Invalid attachment.'
          );
        }

        const media = await getMedia(attachmentId);

        if (
          !media ||
          Number(media.ownerId) !== sessionId ||
          Number(media.recipientId) !== recipient ||
          media.purpose !== 'message'
        ) {
          return apiError(
            res,
            403,
            'This attachment is not available for this conversation.'
          );
        }
      }

      const message = await createMessage({
        senderId: sender,
        recipientId: recipient,
        content: cleanContent || 'Attachment',
        type,
        mediaId,
      });

      emitMessage(message);

      return res.status(201).json({
        success: true,
        message,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to send message.'
      );
    }
  }
);

// ==================================================
// MEDIA UPLOAD
// ==================================================

app.post(
  '/api/media',
  requireSession,
  express.raw({
    type: 'application/octet-stream',
    limit: '100mb',
  }),
  async (req, res) => {
    let savedFilePath = null;

    try {
      if (
        !Buffer.isBuffer(req.body) ||
        req.body.length === 0
      ) {
        return apiError(
          res,
          400,
          'The selected file is empty.'
        );
      }

      const purpose = req.get('x-media-purpose');

      const recipientId =
        validId(req.get('x-recipient-id')) || null;

      if (
        !['message', 'status'].includes(purpose) ||
        (purpose === 'message' && !recipientId)
      ) {
        return apiError(
          res,
          400,
          'A valid upload purpose and conversation are required.'
        );
      }

      const ownerId = Number(req.sessionUser.id);

      if (
        purpose === 'message' &&
        recipientId === ownerId
      ) {
        return apiError(
          res,
          400,
          'Choose another conversation participant.'
        );
      }

      if (purpose === 'message') {
        const users = await getUsers();

        if (
          !users.some(user => Number(user.id) === recipientId)
        ) {
          return apiError(
            res,
            404,
            'Conversation participant not found.'
          );
        }
      }

      const originalName = safeDownloadName(
        decodeFileName(req.get('x-file-name'))
      );

      if (isDangerousFileName(originalName)) {
        return apiError(
          res,
          415,
          'This file extension is not supported.'
        );
      }

      const suppliedType =
        req.get('x-file-content-type') ||
        'application/octet-stream';

      const mimeType = suppliedType
        .split(';', 1)[0]
        .trim()
        .toLowerCase();

      if (
        !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ||
        /^(text\/html|application\/(javascript|x-javascript|x-msdownload|x-executable|x-sh)|image\/svg\+xml)$/i.test(mimeType)
      ) {
        return apiError(
          res,
          415,
          'This file type is not supported for secure upload.'
        );
      }

      if (!validMediaSignature(req.body, mimeType)) {
        return apiError(
          res,
          415,
          'The file contents do not match the selected file type.'
        );
      }

      const storageName =
        `${crypto.randomUUID()}${path.extname(originalName).toLowerCase().slice(0, 16)}`;

      await fs.promises.mkdir(
        MEDIA_DIRECTORY,
        { recursive: true }
      );

      savedFilePath = safeMediaPath(storageName);

      await fs.promises.writeFile(
        savedFilePath,
        req.body,
        { flag: 'wx' }
      );

      const media = await createMedia({
        ownerId,
        recipientId,
        purpose,
        originalName,
        storageName,
        mimeType,
        size: req.body.length,
      });

      return res.status(201).json({
        success: true,
        media,
      });
    } catch (error) {
      if (savedFilePath) {
        await fs.promises
          .unlink(savedFilePath)
          .catch(() => {});
      }

      const status =
        error.status ||
        (error.type === 'entity.too.large' ? 413 : 400);

      return apiError(
        res,
        status,
        error.type === 'entity.too.large'
          ? 'Files must be 100 MB or smaller.'
          : error.message || 'Media upload failed.'
      );
    }
  }
);

// ==================================================
// MEDIA DOWNLOAD
// ==================================================

app.get(
  '/api/media/:id',
  requireSession,
  async (req, res) => {
    try {
      const mediaId = validId(req.params.id);

      if (!mediaId) {
        return apiError(
          res,
          400,
          'Invalid attachment ID.'
        );
      }

      const media = await getMedia(mediaId);

      if (!media) {
        return apiError(
          res,
          404,
          'Attachment not found.'
        );
      }

      const sessionId = Number(req.sessionUser.id);

      let authorized = false;

      if (media.purpose === 'message') {
        authorized =
          Number(media.ownerId) === sessionId ||
          Number(media.recipientId) === sessionId;
      }

      if (
        media.purpose === 'status' &&
        media.statusId
      ) {
        const status = await getStatus(media.statusId);

        authorized = Boolean(
          status &&
          await canViewStatus(status, sessionId)
        );
      }

      if (!authorized) {
        return apiError(
          res,
          403,
          'You are not allowed to download this attachment.'
        );
      }

      const filePath = safeMediaPath(media.storageName);

      await fs.promises.access(
        filePath,
        fs.constants.R_OK
      );

      const inline =
        req.query.inline === '1' &&
        canInlineMedia(media.mimeType);

      const asciiName = safeDownloadName(
        media.originalName
      )
        .replace(/[^\x20-\x7e]/g, '_')
        .replace(/"/g, '_');

      const encodedName = encodeURIComponent(
        media.originalName
      );

      res.set({
        'Content-Type': media.mimeType,
        'Content-Length': String(media.size),
        'Content-Disposition':
          `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });

      const stream = fs.createReadStream(filePath);

      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(404).json({
            success: false,
            message: 'The stored attachment is unavailable.',
          });
        } else {
          res.destroy();
        }
      });

      stream.pipe(res);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return apiError(
          res,
          404,
          'The stored attachment is unavailable.'
        );
      }

      return apiError(
        res,
        500,
        'Unable to download this attachment.'
      );
    }
  }
);

// ==================================================
// STATUSES
// ==================================================

app.get(
  '/api/statuses',
  requireSession,
  async (req, res) => {
    try {
      const statuses = await getStatuses(
        Number(req.sessionUser.id)
      );

      return res.json(statuses);
    } catch {
      return apiError(
        res,
        500,
        'Unable to load statuses.'
      );
    }
  }
);

// ==================================================
// CREATE STATUS
// ==================================================

app.post(
  '/api/statuses',
  requireSession,
  async (req, res) => {
    try {
      const {
        content,
        caption,
        type,
        mediaIds = [],
        linkUrl,
        visibility,
        excludedUserIds,
        includedUserIds,
        saved,
      } = req.body || {};

      if (
        !Array.isArray(mediaIds) ||
        mediaIds.length > 10
      ) {
        return apiError(
          res,
          400,
          'Choose up to 10 status attachments.'
        );
      }

      for (const mediaId of mediaIds) {
        const id = validId(mediaId);

        if (!id) {
          return apiError(
            res,
            400,
            'Invalid status attachment.'
          );
        }

        const media = await getMedia(id);

        if (
          !media ||
          Number(media.ownerId) !== Number(req.sessionUser.id) ||
          media.purpose !== 'status'
        ) {
          return apiError(
            res,
            403,
            'One or more selected status files are unavailable.'
          );
        }
      }

      const status = await createStatus({
        userId: req.sessionUser.id,
        content,
        caption,
        type,
        mediaIds,
        linkUrl,
        visibility,
        excludedUserIds,
        includedUserIds,
        saved,
      });

      io.emit('status:update', {
        userId: Number(req.sessionUser.id),
      });

      return res.status(201).json({
        success: true,
        status,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to create status.'
      );
    }
  }
);

// ==================================================
// VIEW STATUS
// ==================================================

app.post(
  '/api/statuses/:id/view',
  requireSession,
  async (req, res) => {
    try {
      const statusId = validId(req.params.id);

      if (!statusId) {
        return apiError(res, 400, 'Invalid status.');
      }

      const view = await recordStatusView(
        statusId,
        req.sessionUser.id
      );

      return res.json({
        success: true,
        view,
      });
    } catch (error) {
      return apiError(
        res,
        403,
        error.message || 'This status is unavailable.'
      );
    }
  }
);

// ==================================================
// STATUS VIEWERS
// ==================================================

app.get(
  '/api/statuses/:id/viewers',
  requireSession,
  async (req, res) => {
    try {
      const statusId = validId(req.params.id);

      if (!statusId) {
        return apiError(res, 400, 'Invalid status.');
      }

      const viewers = await getStatusViewers(
        statusId,
        req.sessionUser.id
      );

      return res.json(viewers);
    } catch (error) {
      return apiError(
        res,
        404,
        error.message || 'Status not found.'
      );
    }
  }
);

// ==================================================
// STATUS REACTIONS
// ==================================================

app.post(
  '/api/statuses/:id/reactions',
  requireSession,
  async (req, res) => {
    try {
      const statusId = validId(req.params.id);

      const reaction = String(
        req.body?.reaction || ''
      ).slice(0, 16);

      if (!statusId || !reaction) {
        return apiError(
          res,
          400,
          'Choose a valid status and reaction.'
        );
      }

      const result = await addStatusReaction(
        statusId,
        req.sessionUser.id,
        reaction
      );

      return res.json({
        success: true,
        reaction: result,
      });
    } catch (error) {
      return apiError(
        res,
        403,
        error.message || 'Unable to react to this status.'
      );
    }
  }
);

// ==================================================
// DELETE STATUS
// ==================================================

app.delete(
  '/api/statuses/:id',
  requireSession,
  async (req, res) => {
    try {
      const statusId = validId(req.params.id);

      if (!statusId) {
        return apiError(res, 400, 'Invalid status.');
      }

      const media = await deleteStatus(
        statusId,
        req.sessionUser.id
      );

      await Promise.all(
        media.map(item =>
          fs.promises
            .unlink(safeMediaPath(item.storageName))
            .catch(() => {})
        )
      );

      io.emit('status:update', {
        userId: Number(req.sessionUser.id),
      });

      return res.json({
        success: true,
      });
    } catch (error) {
      return apiError(
        res,
        404,
        error.message || 'Status not found.'
      );
    }
  }
);

// ==================================================
// NOTIFICATIONS
// ==================================================

app.get(
  '/api/notifications',
  requireSession,
  async (req, res) => {
    try {
      const notifications =
        await getNotificationsForUser(
          Number(req.sessionUser.id)
        );

      return res.json(notifications);
    } catch {
      return apiError(
        res,
        500,
        'Unable to load notifications.'
      );
    }
  }
);

app.post(
  '/api/notifications',
  requireSession,
  async (req, res) => {
    try {
      const {
        type,
        title,
        body,
      } = req.body || {};

      const notification = await createNotification({
        userId: req.sessionUser.id,
        type,
        title,
        body,
      });

      return res.status(201).json({
        success: true,
        notification,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to create notification.'
      );
    }
  }
);

// ==================================================
// ROOMS
// ==================================================

app.get(
  '/api/rooms',
  requireSession,
  async (req, res) => {
    try {
      const rooms = await getRoomsForUser(
        Number(req.sessionUser.id)
      );

      return res.json(rooms);
    } catch {
      return apiError(res, 500, 'Unable to load rooms.');
    }
  }
);

app.post(
  '/api/rooms',
  requireSession,
  async (req, res) => {
    try {
      const {
        name,
        description,
        isPrivate,
      } = req.body || {};

      const room = await createRoom({
        ownerId: req.sessionUser.id,
        name,
        description,
        isPrivate,
      });

      return res.status(201).json({
        success: true,
        room,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to create room.'
      );
    }
  }
);

app.post(
  '/api/rooms/:id/join',
  requireSession,
  async (req, res) => {
    try {
      const roomId = validId(req.params.id);

      if (!roomId) {
        return apiError(res, 400, 'Invalid room.');
      }

      const room = await joinRoom({
        roomId,
        userId: req.sessionUser.id,
        role: 'member',
      });

      return res.status(201).json({
        success: true,
        room,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to join room.'
      );
    }
  }
);

// ==================================================
// GROUPS
// ==================================================

app.get(
  '/api/groups',
  requireSession,
  async (req, res) => {
    try {
      const groups = await getGroupsForUser(
        Number(req.sessionUser.id)
      );

      return res.json(groups);
    } catch {
      return apiError(res, 500, 'Unable to load groups.');
    }
  }
);

app.post(
  '/api/groups',
  requireSession,
  async (req, res) => {
    try {
      const {
        name,
        description,
        isPrivate,
      } = req.body || {};

      const group = await createGroup({
        ownerId: req.sessionUser.id,
        name,
        description,
        isPrivate,
      });

      return res.status(201).json({
        success: true,
        group,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to create group.'
      );
    }
  }
);

app.post(
  '/api/groups/:id/join',
  requireSession,
  async (req, res) => {
    try {
      const groupId = validId(req.params.id);

      if (!groupId) {
        return apiError(res, 400, 'Invalid group.');
      }

      const group = await joinGroup({
        groupId,
        userId: req.sessionUser.id,
        role: 'member',
      });

      return res.status(201).json({
        success: true,
        group,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to join group.'
      );
    }
  }
);

// ==================================================
// STORIES
// ==================================================

app.get(
  '/api/stories',
  requireSession,
  async (req, res) => {
    try {
      const stories = await getStoriesForUser(
        Number(req.sessionUser.id)
      );

      return res.json(stories);
    } catch {
      return apiError(
        res,
        500,
        'Unable to load stories.'
      );
    }
  }
);

app.post(
  '/api/stories',
  requireSession,
  async (req, res) => {
    try {
      const {
        caption,
        mediaUrl,
        type,
        visibility,
      } = req.body || {};

      const story = await createStory({
        userId: req.sessionUser.id,
        caption,
        mediaUrl,
        type,
        visibility,
      });

      return res.status(201).json({
        success: true,
        story,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to create story.'
      );
    }
  }
);

// ==================================================
// USER SETTINGS
// ==================================================

app.get(
  '/api/settings/:userId',
  requireSession,
  async (req, res) => {
    try {
      const requestedId = validId(req.params.userId);
      const sessionId = Number(req.sessionUser.id);

      if (!requestedId || requestedId !== sessionId) {
        return apiError(
          res,
          403,
          'You can only view your own settings.'
        );
      }

      const settings = await getUserSettings(sessionId);

      return res.json(settings);
    } catch {
      return apiError(
        res,
        500,
        'Unable to load settings.'
      );
    }
  }
);

app.post(
  '/api/settings/:userId',
  requireSession,
  async (req, res) => {
    try {
      const requestedId = validId(req.params.userId);
      const sessionId = Number(req.sessionUser.id);

      if (!requestedId || requestedId !== sessionId) {
        return apiError(
          res,
          403,
          'You can only update your own settings.'
        );
      }

      // Preserve existing values when the browser
      // submits only some settings.
      const existing = await getUserSettings(sessionId);
      const body = req.body || {};

      const settings = await upsertUserSettings({
        userId: sessionId,
        theme: body.theme ?? existing.theme,
        language: body.language ?? existing.language,
        aiConsent: body.aiConsent ?? existing.aiConsent,
        notificationsEnabled:
          body.notificationsEnabled ?? existing.notificationsEnabled,
        liveTranslation:
          body.liveTranslation ?? existing.liveTranslation,
        voiceAssistant:
          body.voiceAssistant ?? existing.voiceAssistant,
        wallpaper: body.wallpaper ?? existing.wallpaper,
        accent: body.accent ?? existing.accent,
      });

      return res.json({
        success: true,
        settings,
      });
    } catch (error) {
      return apiError(
        res,
        400,
        error.message || 'Unable to save settings.'
      );
    }
  }
);

// ==================================================
// CHIMIC AI - RESPONSE EXTRACTION
// ==================================================

function extractOpenAIReply(result) {
  if (typeof result?.output_text === 'string') {
    return result.output_text.trim();
  }

  const output = Array.isArray(result?.output)
    ? result.output
    : [];

  return output
    .filter(item => item.type === 'message')
    .flatMap(item =>
      Array.isArray(item.content) ? item.content : []
    )
    .filter(item => item.type === 'output_text')
    .map(item => item.text || '')
    .join('\n')
    .trim();
}

// ==================================================
// CHIMIC AI - CHATGPT API
// ==================================================

app.post(
  '/api/ai',
  aiLimiter,
  requireSession,
  async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;

      if (!apiKey) {
        return apiError(
          res,
          503,
          'Chimic AI has not been configured on the server.'
        );
      }

      const message =
        typeof req.body?.message === 'string'
          ? req.body.message.trim()
          : '';

      if (!message) {
        return apiError(
          res,
          400,
          'Please enter a message.'
        );
      }

      if (message.length > 10000) {
        return apiError(
          res,
          400,
          'Your message is too long.'
        );
      }

      const userId = Number(req.sessionUser.id);

      // Consent is stored as an integer in SQL.js.
      const settings = await getUserSettings(userId);

      if (Number(settings?.aiConsent) !== 1) {
        return apiError(
          res,
          403,
          'Enable AI assistant consent in settings before using Chimic AI.'
        );
      }

      // The browser must not be allowed to invent
      // previous assistant messages.
      const assistantUserId =
        req.body?.assistantUserId !== undefined
          ? validId(req.body.assistantUserId)
          : null;

      let assistantUser = null;
      let conversationHistory = [];

      if (req.body?.assistantUserId !== undefined) {
        if (!assistantUserId) {
          return apiError(
            res,
            400,
            'Invalid assistant conversation.'
          );
        }

        const users = await getUsers();

        assistantUser = users.find(user =>
          Number(user.id) === assistantUserId &&
          Number(user.id) !== userId &&
          isBotUser(user)
        );

        if (!assistantUser) {
          return apiError(
            res,
            404,
            'The Chimic AI account could not be found.'
          );
        }

        const conversation =
          await getMessagesBetweenUsers(
            userId,
            assistantUserId
          );

        const latestMessage = conversation.at(-1);

        // Confirm that the latest saved message really
        // belongs to this logged-in user.
        if (
          !latestMessage ||
          Number(latestMessage.senderId) !== userId ||
          String(latestMessage.content) !== message
        ) {
          return apiError(
            res,
            409,
            'Send your message in the Chimic AI conversation first.'
          );
        }

        // Use only database-backed previous messages.
        // Exclude the latest message because it is added
        // separately below.
        conversationHistory = conversation
          .slice(0, -1)
          .slice(-10)
          .map(item => ({
            role:
              Number(item.senderId) === assistantUserId
                ? 'assistant'
                : 'user',
            content: String(item.content || '').slice(0, 4000),
          }))
          .filter(item => item.content.trim());
      }

      const controller = new AbortController();

      const timeout = setTimeout(() => {
        controller.abort();
      }, 45000);

      let openAIResponse;

      try {
        openAIResponse = await fetch(OPENAI_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            instructions:
              'You are Chimic AI, the official AI assistant inside Chimic Connect. ' +
              'Be friendly, helpful, accurate and respectful. ' +
              'Help users understand Chimic Connect features, troubleshoot ordinary website problems, ' +
              'and answer general educational and everyday questions. ' +
              'Use clear language. Never claim to have performed actions you have not performed. ' +
              'Do not request passwords, API keys or private authentication tokens.',
            input: [
              ...conversationHistory,
              {
                role: 'user',
                content: message,
              },
            ],
            max_output_tokens: 700,
            store: false,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      let result;

      try {
        result = await openAIResponse.json();
      } catch {
        console.error('OpenAI returned invalid JSON.');

        return apiError(
          res,
          502,
          'Chimic AI received an invalid response.'
        );
      }

      if (!openAIResponse.ok) {
        console.error(
          'OpenAI request failed:',
          openAIResponse.status,
          result?.error?.message || openAIResponse.statusText
        );

        return apiError(
          res,
          502,
          'Chimic AI could not respond. Please try again.'
        );
      }

      const reply = extractOpenAIReply(result);

      if (!reply) {
        return apiError(
          res,
          502,
          'Chimic AI returned an empty response.'
        );
      }

      let savedMessage = null;

      // Save the AI answer as a normal message from
      // the bot account to the current user.
      if (assistantUser) {
        savedMessage = await createMessage({
          senderId: assistantUser.id,
          recipientId: userId,
          content: reply,
          type: 'text',
        });

        emitMessage(savedMessage);
      }

      return res.json({
        success: true,
        reply,
        answer: reply,
        message: savedMessage,
      });

    } catch (error) {
      if (
        error.name === 'AbortError' ||
        error.name === 'TimeoutError'
      ) {
        return apiError(
          res,
          504,
          'Chimic AI took too long to respond. Please try again.'
        );
      }

      console.error(
        'Chimic AI server error:',
        error.message
      );

      return apiError(
        res,
        500,
        'Unable to connect to Chimic AI.'
      );
    }
  }
);

// ==================================================
// UNKNOWN API ROUTES
// ==================================================

app.use('/api', (_req, res) => {
  return apiError(
    res,
    404,
    'Chimic Connect API route not found.'
  );
});

// ==================================================
// GLOBAL ERROR HANDLER
// ==================================================

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status =
    Number(error.status) ||
    (error.type === 'entity.too.large' ? 413 : 500);

  if (status >= 500) {
    console.error(
      'Chimic Connect server error:',
      error
    );
  }

  const message =
    error.type === 'entity.too.large'
      ? 'The submitted data is too large.'
      : status < 500
        ? 'The request is invalid.'
        : 'The request could not be completed.';

  return res.status(status).json({
    success: false,
    message,
    error: message,
  });
});

// ==================================================
// WEBSITE FALLBACK
// Express 5-compatible fallback route.
// ==================================================

app.get(/.*/, (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

// ==================================================
// SOCKET.IO AUTHENTICATION
// ==================================================

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token || typeof token !== 'string') {
      return next(new Error('unauthorized'));
    }

    const user = await getSessionUser(token);

    if (!user) {
      return next(new Error('unauthorized'));
    }

    socket.data.sessionUser = user;

    return next();
  } catch {
    return next(new Error('unauthorized'));
  }
});

// ==================================================
// REAL-TIME CONNECTIONS
// ==================================================

io.on('connection', socket => {
  const userId = Number(
    socket.data.sessionUser.id
  );

  const userRoom = `user-${userId}`;

  socket.join(userRoom);

  io.emit('presence:status', {
    userId,
    online: true,
  });

  socket.on('typing:start', payload => {
    const recipientId = validId(
      payload?.recipientId
    );

    if (!recipientId || recipientId === userId) {
      return;
    }

    emitToUser(
      recipientId,
      'typing:state',
      {
        senderId: userId,
        recipientId,
        typing: true,
      }
    );
  });

  socket.on('typing:stop', payload => {
    const recipientId = validId(
      payload?.recipientId
    );

    if (!recipientId || recipientId === userId) {
      return;
    }

    emitToUser(
      recipientId,
      'typing:state',
      {
        senderId: userId,
        recipientId,
        typing: false,
      }
    );
  });

  socket.on('disconnect', async () => {
    try {
      const remainingSockets = await io
        .in(userRoom)
        .fetchSockets();

      if (remainingSockets.length === 0) {
        io.emit('presence:status', {
          userId,
          online: false,
        });
      }
    } catch (error) {
      console.error(
        'Presence update failed:',
        error.message
      );
    }
  });
});

// ==================================================
// DATABASE AND SERVER STARTUP
// ==================================================

async function startServer() {
  try {
    await initDatabase();

    await fs.promises.mkdir(
      MEDIA_DIRECTORY,
      { recursive: true }
    );

    if (!server.listening) {
      await new Promise((resolve, reject) => {
        const onError = error => {
          server.removeListener('listening', onListening);
          reject(error);
        };

        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);

        server.listen(PORT);
      });
    }

    console.log('================================');
    console.log('CHIMIC CONNECT IS RUNNING');
    console.log(`Port: ${PORT}`);
    console.log(`AI configured: ${Boolean(process.env.OPENAI_API_KEY)}`);
    console.log(`AI model: ${OPENAI_MODEL}`);
    console.log('================================');

  } catch (error) {
    console.error(
      'Chimic Connect startup failed:',
      error
    );

    process.exitCode = 1;
  }
}

// ==================================================
// START SERVER
// ==================================================

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  io,
  PORT,
  startServer,
};
