'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { isValidVideoId, search } = require('./ytdlp');
const themes = require('./themes');

const VERSION = '1.16.1';
const SERVER_VERSION = '1.0.0';
const USERNAME = 'mehfil';
const PASSWORD = 'mehfil123';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlElement(name, value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((item) => xmlElement(name, item)).join('');
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    const attributes = entries
      .filter(([, childValue]) => childValue !== null && typeof childValue !== 'object')
      .map(([attribute, childValue]) => ` ${attribute}="${xmlEscape(childValue)}"`)
      .join('');
    const children = entries
      .filter(([, childValue]) => childValue !== null && typeof childValue === 'object')
      .map(([childName, childValue]) => xmlElement(childName, childValue))
      .join('');
    return children
      ? `<${name}${attributes}>${children}</${name}>`
      : `<${name}${attributes}/>`;
  }
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

function makeResponse(payload = {}, status = 'ok') {
  return {
    'subsonic-response': {
      status,
      version: VERSION,
      type: 'Mehfil',
      serverVersion: SERVER_VERSION,
      ...payload,
    },
  };
}

function sendResponse(reply, request, payload = {}, status = 'ok', httpStatus = 200) {
  const response = makeResponse(payload, status);
  reply.code(httpStatus);

  if (request.query.f === 'xml') {
    return reply.type('application/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?>${xmlElement('subsonic-response', response['subsonic-response'])}`);
  }

  return reply.type('application/json; charset=utf-8').send(response);
}

function sendError(reply, request, code, message, httpStatus = 200) {
  return sendResponse(reply, request, {
    error: { code, message },
  }, 'failed', httpStatus);
}

async function authenticate(request, reply) {
  const { u: username, t: token, s: salt } = request.query;
  const expected = crypto.createHash('md5')
    .update(`${PASSWORD}${typeof salt === 'string' ? salt : ''}`)
    .digest();
  const supplied = Buffer.alloc(expected.length);
  if (typeof token === 'string') {
    Buffer.from(token, 'hex').copy(supplied, 0, 0, expected.length);
  }
  const tokenMatches = crypto.timingSafeEqual(expected, supplied);

  if (username !== USERNAME
    || typeof salt !== 'string'
    || salt.length === 0
    || typeof token !== 'string'
    || !/^[a-fA-F0-9]{32}$/.test(token)
    || !tokenMatches) {
    return sendError(reply, request, 40, 'Wrong username or password', 401);
  }

}

function findTheme(id) {
  return themes.find((theme) => theme.id === id);
}

function asSong(track, albumId, albumName) {
  const artistName = track.artist || 'Unknown Artist';
  const title = track.title || 'Unknown Track';
  return {
    id: track.videoId,
    parent: albumId,
    isDir: false,
    title,
    name: title,
    album: albumName,
    artist: artistName,
    albumId,
    artistId: albumId,
    track: 1,
    year: 2024,
    genre: 'Music',
    contentType: 'audio/webm',
    coverArt: track.videoId,
    size: 5000000,
    suffix: 'webm',
    duration: track.duration || 0,
    bitRate: 160,
    path: `${artistName}/${albumName}/${title}.webm`,
    isVideo: false,
    created: new Date().toISOString(),
    type: 'music',
  };
}

async function getThemeTracks(theme) {
  const queries = theme.queries.length
    ? theme.queries
    : ['top hits 2024', 'trending songs', 'popular music', 'chart hits', 'viral songs'];
  const resultSets = await Promise.all(queries.map((query) => search(query, 10)));
  const seen = new Set();
  const tracks = [];
  for (const results of resultSets) {
    for (const track of results) {
      if (seen.has(track.videoId)) continue;
      seen.add(track.videoId);
      tracks.push(track);
      if (tracks.length >= 25) return tracks;
    }
  }
  return tracks;
}

function coverArtFile(theme) {
  const relativePath = theme.background.replace(/^\/+/, '');
  const roots = [
    path.join(__dirname, 'public'),
    path.join(__dirname, 'frontend', 'public'),
  ];

  for (const root of roots) {
    const candidate = path.resolve(root, relativePath);
    if (candidate.startsWith(`${path.resolve(root)}${path.sep}`)
      && fs.existsSync(candidate)
      && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function streamProxy(request, reply, videoId) {
  if (!isValidVideoId(videoId)) {
    return sendError(reply, request, 10, 'Invalid or missing parameter: id');
  }

  const socket = request.raw.socket;
  if (!socket.localAddress || !socket.localPort) {
    return sendError(reply, request, 0, 'Unable to proxy audio stream', 502);
  }

  const transport = socket.encrypted ? https : http;
  const proxyRequest = transport.request({
    hostname: socket.localAddress,
    port: socket.localPort,
    method: 'GET',
    path: `/stream?id=${encodeURIComponent(videoId)}`,
    agent: false,
  }, (proxyResponse) => {
    if (proxyResponse.statusCode !== 200) {
      reply.raw.writeHead(proxyResponse.statusCode || 502, {
        'Content-Type': proxyResponse.headers['content-type'] || 'application/json; charset=utf-8',
      });
    } else {
      reply.raw.writeHead(200, {
        'Content-Type': 'audio/webm; codecs=opus',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
    }
    proxyResponse.pipe(reply.raw);
  });

  reply.hijack();
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) proxyRequest.destroy();
  });
  proxyRequest.once('error', (error) => {
    request.log.error({ err: error }, 'Subsonic stream proxy error');
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.raw.end(JSON.stringify({ error: 'Unable to proxy audio stream' }));
    } else if (!reply.raw.destroyed) {
      reply.raw.destroy(error);
    }
  });
  proxyRequest.end();
  return reply;
}

async function proxyThumbnail(videoId, reply) {
  const candidates = [
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/default.jpg`,
  ];
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );

  const sendPlaceholder = (statusCode) => {
    if (reply.raw.destroyed) return reply;
    reply.raw.writeHead(statusCode, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': png.length,
    });
    reply.raw.end(png);
    return reply;
  };

  for (const url of candidates) {
    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const req = https.get(url, { timeout: 5000 }, (res) => {
        if (res.statusCode === 200) {
          reply.raw.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          });
          res.pipe(reply.raw);
          finish('streaming');
          return;
        }
        res.resume();
        finish(res.statusCode === 404 ? 'not-found' : 'unavailable');
      });
      req.on('error', (error) => {
        reply.log.error({ err: error, url }, 'Subsonic thumbnail proxy error');
        finish('error');
      });
      req.on('timeout', () => {
        req.destroy(new Error('Thumbnail request timed out'));
      });
    });

    if (result === 'streaming') return reply;
    if (result === 'error') return sendPlaceholder(502);
  }

  return sendPlaceholder(200);
}

module.exports = async function subsonicPlugin(fastify, opts) {
  fastify.addHook('preHandler', authenticate);

  fastify.get('/rest/:method', async (request, reply) => {
    const method = request.params.method.replace(/\.view$/, '');
    const id = typeof request.query.id === 'string' ? request.query.id : '';

    if (method === 'stream') {
      return streamProxy(request, reply, id);
    }

    try {
      switch (method) {
        case 'ping':
          return sendResponse(reply, request);
        case 'getMusicFolders':
          return sendResponse(reply, request, {
            musicFolders: {
              musicFolder: [{ id: '1', name: 'Mehfil' }],
            },
          });
        case 'getArtists':
          return sendResponse(reply, request, {
            artists: {
              index: [{
                name: '#',
                artist: themes.map((theme) => ({
                  id: theme.id,
                  name: theme.name,
                  albumCount: 1,
                  coverArt: theme.id,
                })),
              }],
            },
          });
        case 'getArtist': {
          const theme = findTheme(id);
          if (!theme) return sendError(reply, request, 70, 'Artist not found');
          const queries = theme.queries.length
            ? theme.queries
            : ['top hits 2024', 'trending songs', 'popular music', 'chart hits', 'viral songs'];
          const tracks = await search(queries[0], 10);
          const duration = tracks.reduce((total, track) => total + (track.duration || 0), 0);
          return sendResponse(reply, request, {
            artist: {
              id: theme.id,
              name: theme.name,
              albumCount: 1,
              coverArt: theme.id,
              album: [{
                id: theme.id,
                name: theme.name,
                title: theme.name,
                album: theme.name,
                artist: theme.name,
                artistId: theme.id,
                coverArt: theme.id,
                songCount: tracks.length,
                duration,
                year: 2024,
                genre: 'Music',
                created: new Date().toISOString(),
                playCount: 0,
              }],
            },
          });
        }
        case 'getAlbum': {
          const theme = findTheme(id);
          if (!theme) return sendError(reply, request, 70, 'Album not found');
          const tracks = await getThemeTracks(theme);
          const duration = tracks.reduce((total, track) => total + (track.duration || 0), 0);
          return sendResponse(reply, request, {
            album: {
              id: theme.id,
              name: theme.name,
              title: theme.name,
              album: theme.name,
              artist: theme.name,
              artistId: theme.id,
              songCount: tracks.length,
              duration,
              year: 2024,
              genre: 'Music',
              created: new Date().toISOString(),
              playCount: 0,
              coverArt: theme.id,
              song: tracks.map((track) => asSong(track, theme.id, theme.name)),
            },
          });
        }
        case 'getAlbumList2': {
          const type = typeof request.query.type === 'string'
            ? request.query.type
            : 'alphabeticalByName';
          const requestedSize = Number.parseInt(request.query.size, 10);
          const size = Number.isInteger(requestedSize) && requestedSize >= 0
            ? requestedSize
            : 20;
          const requestedOffset = Number.parseInt(request.query.offset, 10);
          const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0
            ? requestedOffset
            : 0;
          const albums = themes.map((theme) => ({
            id: theme.id,
            name: theme.name,
            title: theme.name,
            album: theme.name,
            artist: theme.name,
            artistId: theme.id,
            songCount: 25,
            duration: 0,
            year: 2024,
            genre: 'Music',
            created: new Date().toISOString(),
            playCount: 0,
            coverArt: theme.id,
          }));
          void type;
          return sendResponse(reply, request, {
            albumList2: {
              album: albums.slice(offset, offset + size),
            },
          });
        }
        case 'getPlaylists':
          return sendResponse(reply, request, {
            playlists: { playlist: [] },
          });
        case 'getStarred2':
          return sendResponse(reply, request, {
            starred2: {},
          });
        case 'reportPlayback':
        case 'scrobble':
          return sendResponse(reply, request, {});
        case 'getRandomSongs': {
          const requestedSize = Number.parseInt(request.query.size, 10);
          const size = Number.isInteger(requestedSize) && requestedSize > 0
            ? Math.min(requestedSize, 50)
            : 20;
          const tracks = await search('lofi', size);
          return sendResponse(reply, request, {
            randomSongs: {
              song: tracks.map((track) => asSong(track, 'appana-gana', 'Appana Gana')),
            },
          });
        }
        case 'search3': {
          const query = typeof request.query.query === 'string' ? request.query.query.trim() : '';
          if (!query) return sendError(reply, request, 10, 'Invalid or missing parameter: query');

          const songCount = Math.max(0, Number.parseInt(request.query.songCount, 10) || 20);
          const songOffset = Math.max(0, Number.parseInt(request.query.songOffset, 10) || 0);
          const limit = Math.min(50, songCount + songOffset);
          const tracks = limit > 0 ? await search(query, limit) : [];
          return sendResponse(reply, request, {
            searchResult3: {
              song: tracks.slice(songOffset, songOffset + songCount)
                .map((track) => asSong(track, 'appana-gana', 'Appana Gana')),
            },
          });
        }
        case 'getCoverArt': {
          const theme = findTheme(id);
          if (theme) {
            const file = coverArtFile(theme);
            if (!file) return sendError(reply, request, 70, 'Cover art not found');
            const extension = path.extname(file).toLowerCase();
            const contentType = extension === '.png'
              ? 'image/png'
              : extension === '.webp'
                ? 'image/webp'
                : 'image/jpeg';
            return reply.type(contentType).send(fs.createReadStream(file));
          }
          if (isValidVideoId(id)) {
            reply.hijack();
            return proxyThumbnail(id, reply);
          }
          return sendError(reply, request, 70, 'Cover art not found');
        }
        default:
          return sendError(reply, request, 70, 'The requested data was not found');
      }
    } catch (error) {
      request.log.error({ err: error }, `Subsonic ${method} request failed`);
      return sendError(reply, request, 0, 'Internal server error', 500);
    }
  });
};
