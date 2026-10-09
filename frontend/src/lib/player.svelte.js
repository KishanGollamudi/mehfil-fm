class AudioPlayer {
  queue = $state([]);
  currentIndex = $state(-1);
  isPlaying = $state(false);
  currentTime = $state(0);
  duration = $state(0);
  volume = $state(0.8);
  eqLow = $state(0);
  eqMid = $state(0);
  eqHigh = $state(0);
  masterGain = $state(1);
  errorMessage = $state('');
  currentTrack = $derived(this.queue[this.currentIndex] ?? null);
  effectiveDuration = $derived(
    (Number.isFinite(this.duration) && this.duration > 0)
      ? this.duration
      : (Number.isFinite(this.currentTrack?.duration) && this.currentTrack.duration > 0
          ? this.currentTrack.duration
          : 0)
  );

  audioEl = null;
  audioContext = null;
  gainNode = null;
  lowFilter = null;
  midFilter = null;
  highFilter = null;
  skipTimer = null;
  initialized = false;
  _skipping = false;
  _consecutiveErrors = 0;

  initAudioChain(audioEl) {
    if (!audioEl || this.initialized) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      this.errorMessage = 'Web Audio is not supported by this browser.';
      return;
    }

    this.audioEl = audioEl;
    this.audioContext = new AudioContextClass();

    const source = this.audioContext.createMediaElementSource(audioEl);
    const compressor = this.audioContext.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 6;
    compressor.ratio.value = 2;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    this.lowFilter = this.audioContext.createBiquadFilter();
    this.lowFilter.type = 'lowshelf';
    this.lowFilter.frequency.value = 200;

    this.midFilter = this.audioContext.createBiquadFilter();
    this.midFilter.type = 'peaking';
    this.midFilter.frequency.value = 1000;
    this.midFilter.Q.value = 1;

    this.highFilter = this.audioContext.createBiquadFilter();
    this.highFilter.type = 'highshelf';
    this.highFilter.frequency.value = 6000;

    this.gainNode = this.audioContext.createGain();
    this.updateGain();

    source
      .connect(compressor)
      .connect(this.lowFilter)
      .connect(this.midFilter)
      .connect(this.highFilter)
      .connect(this.gainNode)
      .connect(this.audioContext.destination);

    audioEl.addEventListener('ended', this.onEnded);
    audioEl.addEventListener('timeupdate', this.onTimeUpdate);
    audioEl.addEventListener('durationchange', this.onTimeUpdate);
    audioEl.addEventListener('error', this.onError);
    audioEl.addEventListener('play', this.onPlay);
    audioEl.addEventListener('pause', this.onPause);
    this.initialized = true;
  }

  onEnded = () => this.next();

  onTimeUpdate = () => {
    if (!this.audioEl) return;
    const t = this.audioEl.currentTime;
    this.currentTime = Number.isFinite(t) && t >= 0 ? t : 0;
    const d = this.audioEl.duration;
    this.duration = Number.isFinite(d) && d > 0 ? d : 0;
  };

  onError = () => {
    if (this._skipping) return;
    const messages = {
      1: 'Playback was interrupted.',
      2: 'A network error interrupted playback.',
      3: 'This audio could not be decoded.',
      4: 'This audio format or source is unavailable.',
    };
    const code = this.audioEl?.error?.code;
    this.errorMessage = messages[code] || 'Unable to play this track.';
    this._consecutiveErrors += 1;
    if (this._consecutiveErrors >= 3) {
      this.errorMessage = 'Multiple tracks failed. Check your connection or YouTube access.';
      this.skip();
      return;
    }

    if (this.skipTimer) clearTimeout(this.skipTimer);
    this.skipTimer = setTimeout(() => {
      this.skipTimer = null;
      this._skipInternal();
    }, 1500);
  };

  onPlay = () => {
    this.isPlaying = true;
    this.errorMessage = '';
    this._consecutiveErrors = 0;
  };

  onPause = () => {
    this.isPlaying = false;
  };

  async playTrack(index) {
    if (!this.audioEl || index < 0 || index >= this.queue.length) return;
    this._skipping = true;
    if (this.skipTimer) {
      clearTimeout(this.skipTimer);
      this.skipTimer = null;
    }

    this.currentIndex = index;
    this.currentTime = 0;
    this.duration = Number.isFinite(this.queue[index].duration)
      ? this.queue[index].duration
      : 0;
    this.errorMessage = '';
    this.audioEl.src = `/stream?id=${encodeURIComponent(this.queue[index].videoId)}`;

    try {
      if (this.audioContext?.state === 'suspended') await this.audioContext.resume();
      await this.audioEl.play();
    } catch (error) {
      this.isPlaying = false;
      this.errorMessage = error?.name === 'NotAllowedError'
        ? 'Press play to allow audio playback.'
        : 'Unable to start playback.';
    } finally {
      queueMicrotask(() => { this._skipping = false; });
    }
  }

  loadQueue(tracks, index = 0) {
    this.queue = Array.isArray(tracks) ? [...tracks] : [];
    if (!this.queue.length) {
      this.currentIndex = -1;
      this.skip();
      return;
    }

    const selectedIndex = Math.max(0, Math.min(index, this.queue.length - 1));
    this.playTrack(selectedIndex);
  }

  togglePlay() {
    if (!this.audioEl) return;
    if (this.audioEl.paused) {
      if (this.currentIndex < 0 && this.queue.length) {
        this.playTrack(0);
      } else if (this.currentIndex >= 0) {
        this.audioEl.play().catch(() => {
          this.errorMessage = 'Unable to resume playback.';
        });
      }
    } else {
      this.audioEl.pause();
    }
  }

  next() {
    if (!this.queue.length) return;
    const nextIndex = this.currentIndex + 1;
    if (nextIndex < this.queue.length) this.playTrack(nextIndex);
    else this.skip();
  }

  _skipInternal() {
    if (!this.queue.length) {
      this.skip();
      return;
    }
    const nextIndex = this.currentIndex + 1;
    if (nextIndex < this.queue.length) this.playTrack(nextIndex);
    else this.skip();
  }

  prev() {
    if (!this.queue.length) return;
    if (this.currentTime > 3) {
      this.seek(0);
      return;
    }
    this.playTrack(Math.max(0, this.currentIndex - 1));
  }

  seek(time) {
    if (!this.audioEl) return;
    const numeric = Number(time);
    if (!Number.isFinite(numeric)) return;
    const dur = this.effectiveDuration || numeric;
    const target = Math.max(0, Math.min(numeric, dur));
    try {
      this.audioEl.currentTime = target;
      this.currentTime = target;
    } catch (err) {
      this.errorMessage = 'Seeking is not available for this stream.';
    }
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    this.updateGain();
  }

  setEQ(band, value) {
    const gain = Math.max(-12, Math.min(12, Number(value) || 0));
    if (band === 'low') {
      this.eqLow = gain;
      if (this.lowFilter) this.lowFilter.gain.value = gain;
    } else if (band === 'mid') {
      this.eqMid = gain;
      if (this.midFilter) this.midFilter.gain.value = gain;
    } else if (band === 'high') {
      this.eqHigh = gain;
      if (this.highFilter) this.highFilter.gain.value = gain;
    }
  }

  setMasterGain(value) {
    this.masterGain = Math.max(0, Math.min(2, Number(value) || 0));
    this.updateGain();
  }

  updateGain() {
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setTargetAtTime(
        this.volume * this.masterGain,
        this.audioContext.currentTime,
        0.015,
      );
    }
  }

  skip() {
    if (this.skipTimer) {
      clearTimeout(this.skipTimer);
      this.skipTimer = null;
    }
    if (!this.audioEl) return;
    this._skipping = true;
    this.audioEl.pause();
    this.audioEl.removeAttribute('src');
    this.audioEl.load();
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.currentIndex = -1;
    queueMicrotask(() => { this._skipping = false; });
  }
}

export const player = new AudioPlayer();
