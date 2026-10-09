<script>
  import * as api from './lib/api.js';
  import { player } from './lib/player.svelte.js';
  import Toast from './lib/Toast.svelte';

  let user = $state(null);
  let themes = $state([]);
  let activeTheme = $state(null);
  let tracks = $state([]);
  let loadingTracks = $state(false);
  let searchQuery = $state('');
  let searchResults = $state([]);
  let searching = $state(false);
  let authMode = $state('login');
  let authUsername = $state('');
  let authPassword = $state('');
  let authError = $state('');
  let authLoading = $state(false);
  let playlists = $state([]);
  let expandedPlaylist = $state(null);
  let expandedItems = $state([]);
  let showPlaylistsPanel = $state(false);
  let savePopoverTrack = $state(null);
  let newPlaylistName = $state('');
  let toastMessage = $state('');
  let toastVisible = $state(false);
  let audioEl = $state(null);
  let showEQ = $state(false);

  let initialized = false;
  let toastTimer;

  function notify(message) {
    toastMessage = message;
    toastVisible = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastVisible = false;
    }, 2800);
  }

  async function loadThemes() {
    try {
      const data = await api.getThemes();
      themes = data.themes || [];
      if (themes.length && !activeTheme) selectTheme(themes[0]);
    } catch (error) {
      notify(error.message);
    }
  }

  async function selectTheme(theme) {
    activeTheme = theme;
    document.documentElement.style.setProperty('--accent', theme.accent || '#9d4edd');
    const layer = document.getElementById('bg-layer');
    if (layer) {
      layer.style.opacity = '0';
      const applyColor = () => {
        layer.style.backgroundColor = theme.background || '#0e0e12';
        layer.style.backgroundImage = 'none';
        requestAnimationFrame(() => {
          layer.style.opacity = '1';
        });
      };
      if (/^(https?:|data:image\/)/i.test(theme.background || '')) {
        const image = new Image();
        image.onload = () => {
          layer.style.backgroundImage = `url("${theme.background}")`;
          requestAnimationFrame(() => {
            layer.style.opacity = '1';
          });
        };
        image.onerror = applyColor;
        image.src = theme.background;
      } else {
        const preload = new Image();
        preload.src = theme.background || '';
        applyColor();
      }
    }

    searchQuery = '';
    searchResults = [];
    searching = false;
    if (theme.searchable) {
      tracks = [];
      loadingTracks = false;
      return;
    }

    loadingTracks = true;
    try {
      const data = await api.getThemeTracks(theme.id);
      if (activeTheme?.id === theme.id) tracks = data.tracks || [];
    } catch (error) {
      if (activeTheme?.id === theme.id) notify(error.message);
    } finally {
      if (activeTheme?.id === theme.id) loadingTracks = false;
    }
  }

  async function handleAuth(event) {
    event.preventDefault();
    authError = '';
    authLoading = true;
    try {
      const data = authMode === 'signup'
        ? await api.signup(authUsername, authPassword)
        : await api.login(authUsername, authPassword);
      user = data.user;
      authPassword = '';
      await loadThemes();
    } catch (error) {
      authError = error.message;
    } finally {
      authLoading = false;
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch (error) {
      notify(error.message);
    }
    user = null;
    themes = [];
    activeTheme = null;
    tracks = [];
    searchResults = [];
    showPlaylistsPanel = false;
    savePopoverTrack = null;
    player.loadQueue([], 0);
  }

  function playFrom(list, index) {
    player.loadQueue(list, index);
  }

  async function openSavePopover(track, event) {
    event.stopPropagation();
    savePopoverTrack = track;
    newPlaylistName = '';
    await loadPlaylists();
  }

  async function loadPlaylists() {
    try {
      const data = await api.getPlaylists();
      playlists = data.playlists || [];
    } catch (error) {
      notify(error.message);
    }
  }

  async function addTrackToPlaylist(playlist) {
    if (!savePopoverTrack) return;
    try {
      await api.addToPlaylist(playlist.id, savePopoverTrack);
      notify(`Added to ${playlist.name}`);
      savePopoverTrack = null;
      await loadPlaylists();
    } catch (error) {
      notify(error.message);
    }
  }

  async function createAndSave(event) {
    event.preventDefault();
    const name = newPlaylistName.trim();
    if (!name || !savePopoverTrack) return;
    try {
      const data = await api.createPlaylist(name);
      await api.addToPlaylist(data.playlist.id, savePopoverTrack);
      notify(`Created ${data.playlist.name} and added track`);
      savePopoverTrack = null;
      newPlaylistName = '';
      await loadPlaylists();
    } catch (error) {
      notify(error.message);
    }
  }

  async function togglePlaylistsPanel() {
    showPlaylistsPanel = !showPlaylistsPanel;
    savePopoverTrack = null;
    if (showPlaylistsPanel) await loadPlaylists();
  }

  async function togglePlaylist(playlist) {
    if (expandedPlaylist === playlist.id) {
      expandedPlaylist = null;
      expandedItems = [];
      return;
    }

    expandedPlaylist = playlist.id;
    expandedItems = [];
    try {
      const data = await api.getPlaylist(playlist.id);
      if (expandedPlaylist === playlist.id) expandedItems = data.items || [];
    } catch (error) {
      notify(error.message);
    }
  }

  function playPlaylist(items) {
    const queue = items.map((item) => ({
      videoId: item.video_id,
      title: item.title,
      artist: item.artist,
      thumbnail: item.thumbnail,
      duration: item.duration,
    }));
    playFrom(queue, 0);
  }

  async function removeItem(playlistId, itemId) {
    try {
      await api.removeFromPlaylist(playlistId, itemId);
      expandedItems = expandedItems.filter((item) => item.id !== itemId);
      await loadPlaylists();
    } catch (error) {
      notify(error.message);
    }
  }

  async function removePlaylist(playlist) {
    if (!confirm(`Delete "${playlist.name}" and all its tracks?`)) return;
    try {
      await api.deletePlaylist(playlist.id);
      if (expandedPlaylist === playlist.id) {
        expandedPlaylist = null;
        expandedItems = [];
      }
      await loadPlaylists();
      notify('Playlist deleted');
    } catch (error) {
      notify(error.message);
    }
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${minutes}:${remainder}`;
  }

  function handleKeydown(event) {
    const target = event.target;
    if (target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      player.togglePlay();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      player.prev();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      player.next();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      player.setVolume(Math.min(1, player.volume + 0.05));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      player.setVolume(Math.max(0, player.volume - 0.05));
    }
  }

  $effect(() => {
    if (!audioEl || initialized) return;
    initialized = true;
    player.initAudioChain(audioEl);
    api.me()
      .then((data) => {
        user = data.user;
        return loadThemes();
      })
      .catch(() => {
        user = null;
      });
    return () => {
      if (toastTimer) clearTimeout(toastTimer);
    };
  });

  $effect(() => {
    const query = searchQuery.trim();
    if (!user || !activeTheme?.searchable) return;
    if (!query) {
      searchResults = [];
      searching = false;
      return;
    }

    const controller = new AbortController();
    searching = true;
    const timer = setTimeout(async () => {
      try {
        const data = await api.search(query, { signal: controller.signal });
        searchResults = data.tracks || [];
      } catch (error) {
        if (error.name !== 'AbortError') notify(error.message);
      } finally {
        if (!controller.signal.aborted) searching = false;
      }
    }, 400);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<audio bind:this={audioEl} crossorigin="anonymous" preload="none"></audio>

{#if !user}
  <main class="auth-page">
    <section class="auth-card">
      <div class="brand-mark">♪</div>
      <p class="eyebrow">YOUR SOUNDTRACK, YOUR WAY</p>
      <h1>Welcome to <span>Mehfil</span></h1>
      <p class="auth-subtitle">Sign in to find the music for every moment.</p>

      <div class="auth-tabs" role="tablist" aria-label="Authentication">
        <button
          class:chosen={authMode === 'login'}
          role="tab"
          aria-selected={authMode === 'login'}
          onclick={() => { authMode = 'login'; authError = ''; }}
        >Log in</button>
        <button
          class:chosen={authMode === 'signup'}
          role="tab"
          aria-selected={authMode === 'signup'}
          onclick={() => { authMode = 'signup'; authError = ''; }}
        >Create account</button>
      </div>

      <form onsubmit={handleAuth}>
        <label for="username">Username</label>
        <input
          id="username"
          name="username"
          autocomplete="username"
          minlength="3"
          maxlength="32"
          required
          bind:value={authUsername}
          placeholder="Your username"
        />
        <label for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete={authMode === 'login' ? 'current-password' : 'new-password'}
          minlength="8"
          required
          bind:value={authPassword}
          placeholder="At least 8 characters"
        />
        {#if authError}<p class="form-error" role="alert">{authError}</p>{/if}
        <button class="primary-button auth-submit" type="submit" disabled={authLoading}>
          {authLoading ? 'Please wait…' : authMode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
    </section>
  </main>
{:else}
  <div id="bg-layer" aria-hidden="true"></div>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Mehfil home">
        <span class="brand-icon">♪</span>
        <span>mehfil<span class="brand-dot">.</span></span>
      </a>
      <div class="header-actions">
        <button class="subtle-button" onclick={togglePlaylistsPanel}>♫ <span>My Playlists</span></button>
        <span class="user-name">{user.username}</span>
        <button class="icon-button logout-button" aria-label="Log out" title="Log out" onclick={handleLogout}>↗</button>
      </div>
    </header>

    <div class="workspace">
      <aside class="sidebar" aria-label="Music themes">
        <p class="section-label">YOUR MOOD</p>
        {#each themes as theme (theme.id)}
          <button
            class="theme-link"
            class:active={activeTheme?.id === theme.id}
            style:--theme-accent={theme.accent}
            onclick={() => selectTheme(theme)}
          >
            <span class="theme-icon">{theme.icon}</span>
            <span>{theme.name}</span>
            {#if theme.searchable}<span class="search-mark">⌕</span>{/if}
          </button>
        {/each}
        <div class="sidebar-note">
          <span>✦</span>
          <p>Every moment has a melody.</p>
        </div>
      </aside>

      <main class="main-panel">
        {#if activeTheme}
          <section class="collection-heading">
            <div class="collection-icon" style:--theme-accent={activeTheme.accent}>{activeTheme.icon}</div>
            <div>
              <p class="eyebrow">A MEHFIL FOR</p>
              <h1>{activeTheme.name}</h1>
              <p class="collection-description">{activeTheme.description}</p>
            </div>
          </section>
        {/if}

        {#if activeTheme?.searchable}
          <label class="search-field">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder="Search songs, artists, moods…"
              bind:value={searchQuery}
              aria-label="Search music"
            />
            {#if searching}<span class="search-spinner" aria-label="Searching"></span>{/if}
          </label>
        {/if}

        {#if loadingTracks || searching}
          <div class="track-list skeleton-list" aria-label="Loading tracks">
            {#each [1, 2, 3, 4, 5] as item (item)}
              <div class="skeleton-row">
                <span class="skeleton-thumb"></span>
                <span class="skeleton-copy"><i></i><i></i></span>
              </div>
            {/each}
          </div>
        {:else}
          {@const visibleTracks = activeTheme?.searchable ? searchResults : tracks}
          {#if visibleTracks.length}
            <div class="track-list">
              {#each visibleTracks as track, index (track.videoId)}
                <div
                  class="track-row"
                  class:playing={player.currentTrack?.videoId === track.videoId}
                  role="button"
                  aria-label={`Play ${track.title}`}
                  tabindex="0"
                  onclick={() => playFrom(visibleTracks, index)}
                  onkeydown={(event) => {
                    if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
                      event.preventDefault();
                      playFrom(visibleTracks, index);
                    }
                  }}
                >
                  <span class="track-art">
                    {#if track.thumbnail}
                      <img src={track.thumbnail} alt="" loading="lazy" />
                    {:else}
                      <span>♪</span>
                    {/if}
                    <span class="art-play">{player.currentTrack?.videoId === track.videoId && player.isPlaying ? 'Ⅱ' : '▶'}</span>
                  </span>
                  <span class="track-copy">
                    <span class="track-title">{track.title}</span>
                    <span class="track-artist">{track.artist}</span>
                  </span>
                  <span class="track-duration">{formatTime(track.duration)}</span>
                  {#if activeTheme?.searchable}
                    <button
                      class="row-action"
                      aria-label={`Save ${track.title} to a playlist`}
                      title="Save to playlist"
                      onclick={(event) => openSavePopover(track, event)}
                    >＋</button>
                  {/if}
                  <button
                    class="row-play"
                    aria-label={`Play ${track.title}`}
                    onclick={(event) => { event.stopPropagation(); playFrom(visibleTracks, index); }}
                  >{player.currentTrack?.videoId === track.videoId && player.isPlaying ? 'Ⅱ' : '▶'}</button>
                </div>
              {/each}
            </div>
          {:else if activeTheme?.searchable && !searchQuery.trim()}
            <div class="empty-state">
              <span>⌕</span>
              <h2>What are you in the mood for?</h2>
              <p>Search for a song, artist, or sound to start your mehfil.</p>
            </div>
          {:else}
            <div class="empty-state">
              <span>♫</span>
              <h2>No tracks found</h2>
              <p>Try another search or choose a different mood.</p>
            </div>
          {/if}
        {/if}
      </main>
    </div>
  </div>

  <section class="player-bar" aria-label="Audio player">
    <div class="now-playing">
      <div class="mini-art">
        {#if player.currentTrack?.thumbnail}
          <img src={player.currentTrack.thumbnail} alt="" />
        {:else}
          <span>♪</span>
        {/if}
      </div>
      <div class="now-copy">
        <span class="now-title">{player.currentTrack?.title || 'Choose a track to begin'}</span>
        <span class="now-artist">{player.currentTrack?.artist || 'Your mehfil is waiting'}</span>
      </div>
    </div>

    <div class="transport">
      <div class="transport-buttons">
        <button class="player-control" aria-label="Previous track" onclick={() => player.prev()}>|◀</button>
        <button class="play-button" aria-label={player.isPlaying ? 'Pause' : 'Play'} onclick={() => player.togglePlay()}>
          {player.isPlaying ? 'Ⅱ' : '▶'}
        </button>
        <button class="player-control" aria-label="Next track" onclick={() => player.next()}>▶|</button>
      </div>
      <div class="timeline">
        <span>{formatTime(player.currentTime)}</span>
        <input
          type="range"
          min="0"
          max={player.effectiveDuration || 1}
          step="0.1"
          value={player.currentTime}
          disabled={!player.effectiveDuration}
          aria-label="Seek"
          oninput={(event) => player.seek(Number(event.currentTarget.value))}
        />
        <span>{formatTime(player.effectiveDuration)}</span>
      </div>
    </div>

    <div class="player-options">
      {#if player.errorMessage}<span class="player-error" title={player.errorMessage}>!</span>{/if}
      <button class="icon-button eq-button" class:active={showEQ} aria-label="Equalizer" title="Equalizer" onclick={() => showEQ = !showEQ}>≋</button>
      <span class="volume-icon" aria-hidden="true">{player.volume === 0 ? '◖' : '◖))'}</span>
      <input
        class="volume-range"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={player.volume}
        aria-label="Volume"
        oninput={(event) => player.setVolume(Number(event.currentTarget.value))}
      />
    </div>
  </section>

  {#if showEQ}
    <section class="eq-panel" aria-label="Equalizer controls">
      <div class="eq-heading">
        <strong>Equalizer</strong>
        <button class="icon-button" aria-label="Close equalizer" onclick={() => showEQ = false}>×</button>
      </div>
      <label>Bass <span>{player.eqLow} dB</span>
        <input type="range" min="-12" max="12" step="1" value={player.eqLow} oninput={(event) => player.setEQ('low', event.currentTarget.value)} />
      </label>
      <label>Mid <span>{player.eqMid} dB</span>
        <input type="range" min="-12" max="12" step="1" value={player.eqMid} oninput={(event) => player.setEQ('mid', event.currentTarget.value)} />
      </label>
      <label>Treble <span>{player.eqHigh} dB</span>
        <input type="range" min="-12" max="12" step="1" value={player.eqHigh} oninput={(event) => player.setEQ('high', event.currentTarget.value)} />
      </label>
      <label>Master <span>{player.masterGain.toFixed(1)}×</span>
        <input type="range" min="0" max="2" step="0.05" value={player.masterGain} oninput={(event) => player.setMasterGain(event.currentTarget.value)} />
      </label>
    </section>
  {/if}

  <aside class="playlists-panel" class:open={showPlaylistsPanel} aria-label="Your playlists">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">YOUR COLLECTION</p>
        <h2>Playlists</h2>
      </div>
      <button class="icon-button" aria-label="Close playlists" onclick={() => showPlaylistsPanel = false}>×</button>
    </div>
    {#if playlists.length}
      <div class="playlist-list">
        {#each playlists as playlist (playlist.id)}
          <section class="playlist-card">
            <div class="playlist-heading">
              <button class="playlist-expand" onclick={() => togglePlaylist(playlist)}>
                <span class="playlist-symbol">♫</span>
                <span class="playlist-heading-copy">
                  <strong>{playlist.name}</strong>
                  <small>{playlist.item_count} {playlist.item_count === 1 ? 'track' : 'tracks'}</small>
                </span>
                <span class="expand-chevron">{expandedPlaylist === playlist.id ? '⌄' : '›'}</span>
              </button>
              <button class="row-action delete-playlist" aria-label={`Delete ${playlist.name}`} onclick={() => removePlaylist(playlist)}>×</button>
            </div>
            {#if expandedPlaylist === playlist.id}
              <div class="playlist-detail">
                {#if expandedItems.length}
                  <button class="primary-button play-all" onclick={() => playPlaylist(expandedItems)}>▶ Play all</button>
                  {#each expandedItems as item (item.id)}
                    <div class="playlist-track">
                      <button class="playlist-track-copy" onclick={() => playFrom(expandedItems.map((track) => ({
                        videoId: track.video_id,
                        title: track.title,
                        artist: track.artist,
                        thumbnail: track.thumbnail,
                        duration: track.duration,
                      })), expandedItems.indexOf(item))}>
                        <strong>{item.title}</strong>
                        <small>{item.artist}</small>
                      </button>
                      <button class="row-action" aria-label={`Remove ${item.title}`} onclick={() => removeItem(playlist.id, item.id)}>×</button>
                    </div>
                  {/each}
                {:else}
                  <p class="empty-playlist">This playlist is empty.</p>
                {/if}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {:else}
      <div class="empty-panel">
        <span>♫</span>
        <p>No playlists yet. Save a track to start one.</p>
      </div>
    {/if}
  </aside>
  {#if showPlaylistsPanel}
    <button class="panel-backdrop" aria-label="Close playlists panel" onclick={() => showPlaylistsPanel = false}></button>
  {/if}

  {#if savePopoverTrack}
    <div class="popover-backdrop" role="presentation" onclick={() => savePopoverTrack = null} onkeydown={(event) => event.key === 'Escape' && (savePopoverTrack = null)}></div>
    <section class="save-popover" aria-label="Save track to playlist">
      <div class="popover-heading">
        <div>
          <p class="eyebrow">SAVE TRACK</p>
          <h3>{savePopoverTrack.title}</h3>
        </div>
        <button class="icon-button" aria-label="Close" onclick={() => savePopoverTrack = null}>×</button>
      </div>
      {#if playlists.length}
        <div class="save-playlist-options">
          {#each playlists as playlist (playlist.id)}
            <button class="save-playlist-option" onclick={() => addTrackToPlaylist(playlist)}>
              <span>♫</span>{playlist.name}<small>{playlist.item_count}</small>
            </button>
          {/each}
        </div>
      {:else}
        <p class="popover-hint">Create your first playlist below.</p>
      {/if}
      <form class="new-playlist-form" onsubmit={createAndSave}>
        <input
          aria-label="New playlist name"
          maxlength="64"
          required
          placeholder="New playlist name"
          bind:value={newPlaylistName}
        />
        <button class="primary-button" type="submit">Create & add</button>
      </form>
    </section>
  {/if}

  <Toast message={toastMessage} visible={toastVisible} />
{/if}
