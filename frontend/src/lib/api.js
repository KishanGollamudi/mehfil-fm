const API_BASE = '/api';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function post(path, payload) {
  return request(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function signup(username, password) {
  return post('/auth/signup', { username, password });
}

export async function login(username, password) {
  return post('/auth/login', { username, password });
}

export async function logout() {
  return post('/auth/logout', {});
}

export async function me() {
  return request('/auth/me');
}

export async function getThemes() {
  return request('/themes');
}

export async function getThemeTracks(id) {
  return request(`/themes/${encodeURIComponent(id)}/tracks`);
}

export async function search(query, { signal } = {}) {
  const params = new URLSearchParams({ q: query });
  return request(`/search?${params}`, { signal });
}

export async function getPlaylists() {
  return request('/playlists');
}

export async function createPlaylist(name) {
  return post('/playlists', { name });
}

export async function getPlaylist(id) {
  return request(`/playlists/${encodeURIComponent(id)}`);
}

export async function addToPlaylist(id, track) {
  return post(`/playlists/${encodeURIComponent(id)}/items`, {
    videoId: track.videoId,
    title: track.title,
    artist: track.artist,
    thumbnail: track.thumbnail || '',
    duration: track.duration ?? null,
  });
}

export async function removeFromPlaylist(id, itemId) {
  return request(
    `/playlists/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
}

export async function deletePlaylist(id) {
  return request(`/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
