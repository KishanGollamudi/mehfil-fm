'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

net.setDefaultAutoSelectFamily(false);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
};

const SEARCH_API = 'https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0';
const SONG_API = 'https://www.jiosaavn.com/api.php?__call=song.getDetails&_format=json&_marker=0&api_version=4&ctx=web6dot0';
const DES_KEY = Buffer.from('38346591', 'utf8');
const ID_REGEX = /^[-_a-zA-Z0-9]+$/;
const SEARCH_CACHE_TTL_MS = 30_000;
const searchCache = new Map();
const trackCache = new Map();

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;|&#039;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function cleanText(value) {
  return decodeHtml(value).replace(/\u0026/gi, '&').replace(/\u0027/g, "'").trim();
}

function decryptMediaUrl(encryptedUrl) {
  if (typeof encryptedUrl !== 'string' || !encryptedUrl.trim()) return '';
  try {
    const encrypted = Buffer.from(encryptedUrl.trim(), 'base64');
    let decipher;
    try {
      decipher = crypto.createDecipheriv('des-ecb', DES_KEY, null);
    } catch {
      // OpenSSL 3 can disable legacy DES; the available 3DES provider with
      // the same key repeated is equivalent to single-DES ECB.
      decipher = crypto.createDecipheriv('des-ede3', Buffer.concat([DES_KEY, DES_KEY, DES_KEY]), null);
    }
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
    return decrypted.replace(/_96\.mp4|_160\.mp4/g, '_320.mp4');
  } catch {
    return '';
  }
}

function artworkUrl(song, more = {}) {
  const raw = more.image || song.image || '';
  return cleanText(raw)
    .replace(/150x150|50x50/g, '500x500');
}

function normalizeTrack(song) {
  if (!song || !song.id) return null;
  const more = song.more_info || song.moreInfo || {};
  const encryptedUrl = more.encrypted_media_url || song.encrypted_media_url;
  const directUrl = more.media_url || song.media_url;
  const decryptedUrl = decryptMediaUrl(encryptedUrl);
  const audioUrl = cleanText(decryptedUrl || directUrl || '')
    .replace(/_96\.mp4|_160\.mp4/g, '_320.mp4');
  if (!audioUrl) return null;

  const coverArt = artworkUrl(song, more);
  const artist = cleanText(more.singers || more.music || song.subtitle || 'Unknown Artist');
  return {
    id: String(song.id),
    title: cleanText(song.title || song.name || 'Unknown Track'),
    artist,
    album: cleanText(more.album || song.album || ''),
    duration: Number(more.duration || song.duration || 0) || 0,
    coverArt,
    audioUrl,
    // Compatibility fields used by the existing frontend and playlist storage.
    videoId: String(song.id),
    thumbnail: coverArt,
  };
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`JioSaavn request failed (${response.status})`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function cacheTrack(track) {
  if (track) trackCache.set(track.id, { track, expiresAt: Date.now() + 10 * 60_000 });
}

async function search(query, limit = 10) {
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('Search query must not be empty');
  const normalizedQuery = query.trim();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  const cacheKey = `${normalizedQuery}|${safeLimit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  if (cached) searchCache.delete(cacheKey);

  const payload = await fetchJson(`${SEARCH_API}&q=${encodeURIComponent(normalizedQuery)}&n=${safeLimit}&p=1`);
  const songs = Array.isArray(payload) ? payload
    : Array.isArray(payload?.results) ? payload.results
      : [];
  const results = songs.map(normalizeTrack).filter(Boolean).slice(0, safeLimit);
  results.forEach(cacheTrack);
  searchCache.set(cacheKey, { results, expiresAt: SEARCH_CACHE_TTL_MS + Date.now() });
  return results;
}

async function resolveSong(id) {
  if (typeof id !== 'string' || !ID_REGEX.test(id)) throw new TypeError('Invalid song ID');
  const cached = trackCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.track;
  if (cached) trackCache.delete(id);

  const payload = await fetchJson(`${SONG_API}&pids=${encodeURIComponent(id)}`);
  const song = payload?.[id] || (Array.isArray(payload?.songs) && payload.songs[0]) || payload;
  const track = normalizeTrack(song);
  if (!track) throw new Error('Song not found');
  cacheTrack(track);
  return track;
}

async function resolveAudioUrl(id) {
  const track = await resolveSong(id);
  if (!track.audioUrl) throw new Error('No audio URL available for song');
  return track.audioUrl;
}

module.exports = {
  search,
  resolveSong,
  resolveAudioUrl,
  decryptMediaUrl,
  cleanText,
  isValidSongId: (id) => typeof id === 'string' && ID_REGEX.test(id),
};
