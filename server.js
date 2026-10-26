'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const formbody = require('@fastify/formbody');
const fastifyStatic = require('@fastify/static');

const db = require('./db');
const themes = require('./themes');
const { isValidVideoId, streamVideo, search } = require('./ytdlp');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const AUTH_RATE_LIMIT_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = 10;
const authAttempts = new Map();

function createSession(userId) {
  const now = Date.now();
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare(`
    INSERT INTO sessions (id, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(sid, userId, now, now + SESSION_TTL_MS);
  return sid;
}

function getSession(sid) {
  if (typeof sid !== 'string' || !sid) return null;
  const session = db.prepare(`
    SELECT sessions.id, sessions.user_id, sessions.expires_at, users.username
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `).get(sid);
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return null;
  }
  return { id: session.user_id, username: session.username };
}

function enforceAuthRateLimit(request, reply) {
  const now = Date.now();
  for (const [ip, attempt] of authAttempts) {
    if (attempt.resetAt <= now) authAttempts.delete(ip);
  }
  const ip = request.ip;
  let attempt = authAttempts.get(ip);
  if (!attempt || attempt.resetAt <= now) {
    attempt = { count: 0, resetAt: now + AUTH_RATE_LIMIT_MS };
    authAttempts.set(ip, attempt);
  }
  attempt.count += 1;
  if (attempt.count > AUTH_RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - now) / 1000));
    reply.header('Retry-After', String(retryAfter));
    return reply.code(429).send({ error: 'Too many authentication attempts' });
  }
}

async function requireAuth(request, reply) {
  const user = getSession(request.cookies.sid);
  if (!user) return reply.code(401).send({ error: 'Authentication required' });
  request.user = user;
}

function validTrackInput(body) {
  return body && typeof body === 'object' && isValidVideoId(body.videoId) &&
    typeof body.title === 'string' && body.title.trim().length > 0 &&
    typeof body.artist === 'string';
}

async function createServer() {
  const app = Fastify({ logger: true });
  const publicDirectory = path.join(__dirname, 'public');
  fs.mkdirSync(publicDirectory, { recursive: true });

  app.register(cookie);
  app.register(formbody);

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/stream', async (request, reply) => {
    const videoId = request.query && request.query.id;
    if (!isValidVideoId(videoId)) return reply.code(400).send({ error: 'Invalid video ID' });

    let child;
    try {
      child = streamVideo(videoId);
    } catch (error) {
      request.log.error({ err: error }, 'Unable to start yt-dlp stream');
      return reply.code(502).send({ error: 'Unable to start audio stream' });
    }
    reply.hijack();

    let headersSent = false;
    let childClosed = false;
    let killTimer;

    const stopChild = () => {
      if (childClosed || child.killed) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!childClosed) child.kill('SIGKILL'); }, 3000);
      killTimer.unref();
    };

    const sendAudioHeaders = () => {
      reply.raw.writeHead(200, {
        'Content-Type': 'audio/webm; codecs=opus',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      headersSent = true;
    };

    reply.raw.once('close', () => { if (!reply.raw.writableEnded) stopChild(); });

    child.stdout.once('data', (firstChunk) => {
      if (reply.raw.destroyed) { stopChild(); return; }
      sendAudioHeaders();
      reply.raw.write(firstChunk);
      child.stdout.pipe(reply.raw);
    });

    child.once('error', (error) => {
      request.log.error({ err: error }, 'yt-dlp stream process error');
      if (!headersSent && !reply.raw.headersSent) {
        reply.raw.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        reply.raw.end(JSON.stringify({ error: 'Unable to start audio stream' }));
      } else if (!reply.raw.destroyed) {
        reply.raw.destroy(error);
      }
    });

    child.once('close', (code, signal) => {
      childClosed = true;
      if (killTimer) clearTimeout(killTimer);
      if (!headersSent) {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          reply.raw.end(JSON.stringify({ error: 'Audio stream was empty' }));
        }
        return;
      }
      if (code !== 0) {
        request.log.error({ code, signal }, 'yt-dlp stream exited unsuccessfully');
        if (!reply.raw.destroyed) reply.raw.destroy();
      }
    });

    return reply;
  });

  app.post('/api/auth/signup', async (request, reply) => {
    if (enforceAuthRateLimit(request, reply)) return;
    const { username, password } = request.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(username) || typeof password !== 'string' || password.length < 8) {
      return reply.code(400).send({ error: 'Username must be 3-32 chars, password 8+ chars' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    let result;
    try {
      result = db.prepare(`INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)`).run(username, passwordHash, Date.now());
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.code(409).send({ error: 'Username already exists' });
      throw error;
    }
    const user = { id: Number(result.lastInsertRowid), username };
    const sid = createSession(user.id);
    reply.setCookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_COOKIE_MAX_AGE });
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (enforceAuthRateLimit(request, reply)) return;
    const { username, password } = request.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') return reply.code(400).send({ error: 'Credentials required' });
    const userRow = db.prepare(`SELECT id, username, password_hash FROM users WHERE username = ?`).get(username);
    if (!userRow || !(await bcrypt.compare(password, userRow.password_hash))) {
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    const user = { id: userRow.id, username: userRow.username };
    const sid = createSession(user.id);
    reply.setCookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_COOKIE_MAX_AGE });
    return reply.send({ user });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const sid = request.cookies.sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    reply.clearCookie('sid', { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = getSession(request.cookies.sid);
    if (!user) return reply.code(401).send({ error: 'Authentication required' });
    return reply.send({ user });
  });

  app.get('/api/themes', { preHandler: requireAuth }, async () => ({
    themes: themes.map(({ queries, ...theme }) => theme),
  }));

  app.get('/api/themes/:id/tracks', { preHandler: requireAuth }, async (request, reply) => {
    const theme = themes.find((item) => item.id === request.params.id);
    if (!theme || theme.searchable) return reply.code(404).send({ error: 'Theme not found' });
    const resultSets = await Promise.all(theme.queries.map((query) => search(query)));
    const seen = new Set();
    const tracks = [];
    for (const results of resultSets) {
      for (const track of results) {
        if (!seen.has(track.videoId)) { seen.add(track.videoId); tracks.push(track); }
        if (tracks.length >= 25) break;
      }
      if (tracks.length >= 25) break;
    }
    return reply.send({ theme: { ...theme, queries: undefined }, tracks });
  });

  app.get('/api/search', { preHandler: requireAuth }, async (request, reply) => {
    const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (!query) return reply.code(400).send({ error: 'Search query is required' });
    return reply.send({ tracks: await search(query, 20) });
  });

  app.get('/api/playlists', { preHandler: requireAuth }, async (request) => {
    const playlists = db.prepare(`SELECT id, name, created_at FROM playlists WHERE user_id = ? ORDER BY created_at DESC`).all(request.user.id);
    return { playlists };
  });

  app.post('/api/playlists', { preHandler: requireAuth }, async (request, reply) => {
    const name = request.body && request.body.name;
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 64) return reply.code(400).send({ error: 'Name must be 1-64 chars' });
    const result = db.prepare(`INSERT INTO playlists (user_id, name, created_at) VALUES (?, ?, ?)`).run(request.user.id, name.trim(), Date.now());
    const playlist = db.prepare(`SELECT id, name, created_at FROM playlists WHERE id = ?`).get(result.lastInsertRowid);
    return reply.code(201).send({ playlist });
  });

  app.get('/api/playlists/:id', { preHandler: requireAuth }, async (request, reply) => {
    const playlist = db.prepare(`SELECT id, name, created_at FROM playlists WHERE id = ? AND user_id = ?`).get(request.params.id, request.user.id);
    if (!playlist) return reply.code(404).send({ error: 'Playlist not found' });
    const items = db.prepare(`SELECT * FROM playlist_items WHERE playlist_id = ?`).all(playlist.id);
    return reply.send({ playlist, items });
  });

  app.post('/api/playlists/:id/items', { preHandler: requireAuth }, async (request, reply) => {
    const playlistId = request.params.id;
    if (!validTrackInput(request.body)) return reply.code(400).send({ error: 'Invalid track details' });
    const result = db.prepare(`
      INSERT INTO playlist_items (playlist_id, video_id, title, artist, thumbnail, duration, added_at)
      SELECT id, ?, ?, ?, ?, ?, ? FROM playlists WHERE id = ? AND user_id = ?
    `).run(request.body.videoId, request.body.title, request.body.artist, request.body.thumbnail || null, request.body.duration || null, Date.now(), playlistId, request.user.id);
    if (result.changes === 0) return reply.code(404).send({ error: 'Playlist not found' });
    return reply.code(201).send({ item: { id: result.lastInsertRowid, ...request.body } });
  });

  app.delete('/api/playlists/:id/items/:itemId', { preHandler: requireAuth }, async (request, reply) => {
    const result = db.prepare(`
      DELETE FROM playlist_items WHERE id = ? AND playlist_id IN (SELECT id FROM playlists WHERE id = ? AND user_id = ?)
    `).run(request.params.itemId, request.params.id, request.user.id);
    if (result.changes === 0) return reply.code(404).send({ error: 'Item not found' });
    return reply.send({ ok: true });
  });

  app.delete('/api/playlists/:id', { preHandler: requireAuth }, async (request, reply) => {
    const result = db.prepare(`DELETE FROM playlists WHERE id = ? AND user_id = ?`).run(request.params.id, request.user.id);
    if (result.changes === 0) return reply.code(404).send({ error: 'Playlist not found' });
    return reply.send({ ok: true });
  });

  app.register(fastifyStatic, {
    root: publicDirectory,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
    decorateReply: true,
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url.startsWith('/api/') || request.raw.url.startsWith('/stream')) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });

  await app.register(require('./subsonic'));
  return app;
}

async function start() {
  const app = await createServer();
  const port = Number(process.env.PORT) || 3000;
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  start();
}

module.exports = { createServer, start, requireAuth };