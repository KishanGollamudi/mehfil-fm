'use strict';

const { spawn } = require('node:child_process');

const SEARCH_CACHE_TTL_MS = 30_000;
const searchCache = new Map();

function isValidVideoId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function streamVideo(videoId) {
  if (!isValidVideoId(videoId)) {
    throw new TypeError('Invalid video ID');
  }

  const args = [
    '-f',
    '251/140',
    '-o',
    '-',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '--no-part',
  ];

  if (process.env.YTDLP_COOKIES) {
    args.push('--cookies', process.env.YTDLP_COOKIES);
  }

  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  return spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function search(query, limit = 10) {
  if (typeof query !== 'string' || !query.trim()) {
    return Promise.reject(new TypeError('Search query must not be empty'));
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return Promise.reject(new RangeError('Search limit must be an integer from 1 to 50'));
  }

  const cacheKey = `${query}|${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.results);
  }
  if (cached) {
    searchCache.delete(cacheKey);
  }

  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch${limit}:${query}`,
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--quiet',
    ];
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      settled = true;
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;

      if (code !== 0) {
        reject(new Error(`yt-dlp search failed (${signal || `exit ${code}`}): ${stderr.trim()}`));
        return;
      }

      try {
        const results = stdout
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => {
            const entry = JSON.parse(line);
            const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
            const thumbnail = entry.thumbnail
              || (thumbnails.length ? thumbnails[thumbnails.length - 1].url : '');

            return {
              videoId: entry.id,
              title: entry.title || '',
              artist: entry.channel || entry.uploader || '',
              thumbnail: thumbnail || '',
              duration: Number.isFinite(entry.duration) ? Math.floor(entry.duration) : null,
            };
          })
          .filter((track) => isValidVideoId(track.videoId));

        searchCache.set(cacheKey, {
          results,
          expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
        });
        resolve(results);
      } catch (error) {
        reject(new Error(`Unable to parse yt-dlp search results: ${error.message}`));
      }
    });
  });
}

module.exports = { isValidVideoId, streamVideo, search };
