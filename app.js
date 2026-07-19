/* =========================================
   StreamVault — IPTV Player Application
   ========================================= */

const M3U_URL = 'https://iptv-org.github.io/iptv/index.m3u';
const FAVORITES_KEY = 'streamvault_favorites';
const VOLUME_KEY = 'streamvault_volume';
const BATCH_SIZE = 80;       // channels to render per batch
const SEARCH_DEBOUNCE = 250; // ms

// ─── State ─────────────────────────────────────────
let allChannels = [];
let filteredChannels = [];
let displayedCount = 0;
let currentChannel = null;
let hlsInstance = null;
let favorites = new Set();
let activeTab = 'all';       // 'all' | 'favorites'
let activeCategory = 'all';
let searchQuery = '';
let isLoadingMore = false;

// ─── DOM References ────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  loadingOverlay: $('#loading-overlay'),
  loaderStatus: $('#loader-status'),
  app: $('#app'),
  sidebar: $('#sidebar'),
  sidebarToggle: $('#sidebar-toggle'),
  searchInput: $('#search-input'),
  searchClear: $('#search-clear'),
  categorySelect: $('#category-select'),
  channelList: $('#channel-list'),
  channelCountText: $('#channel-count-text'),
  playerWrapper: $('#player-wrapper'),
  playerIdle: $('#player-idle'),
  videoPlayer: $('#video-player'),
  bufferingOverlay: $('#buffering-overlay'),
  errorOverlay: $('#error-overlay'),
  errorText: $('#error-text'),
  retryBtn: $('#retry-btn'),
  playerControls: $('#player-controls'),
  playPauseBtn: $('#play-pause-btn'),
  playIcon: $('#play-icon'),
  pauseIcon: $('#pause-icon'),
  muteBtn: $('#mute-btn'),
  volumeIcon: $('#volume-icon'),
  mutedIcon: $('#muted-icon'),
  volumeSlider: $('#volume-slider'),
  liveBadge: $('#live-badge'),
  fsControlBtn: $('#fs-control-btn'),
  fsEnterIcon: $('#fs-enter-icon'),
  fsExitIcon: $('#fs-exit-icon'),
  pipBtn: $('#pip-btn'),
  fullscreenBtn: $('#fullscreen-btn'),
  nowPlayingName: $('#now-playing-name'),
  channelLogoLarge: $('#channel-logo-large'),
  channelNameDisplay: $('#channel-name-display'),
  channelTags: $('#channel-tags'),
  favBtnMain: $('#fav-btn-main'),
  mobileMenuBtn: $('#mobile-menu-btn'),
  mobileOverlay: $('#mobile-overlay'),
  tabAll: $('#tab-all'),
  tabFavorites: $('#tab-favorites'),
};

// ─── Init ──────────────────────────────────────────
(async function init() {
  loadFavorites();
  loadVolume();
  bindEvents();

  try {
    dom.loaderStatus.textContent = 'Fetching playlist…';
    const text = await fetchPlaylist();
    dom.loaderStatus.textContent = 'Parsing channels…';
    allChannels = parseM3U(text);
    populateCategories();
    applyFilters();
    showApp();
  } catch (err) {
    dom.loaderStatus.textContent = 'Failed to load playlist. Refresh to retry.';
    console.error('Init error:', err);
  }
})();

// ─── Fetch ─────────────────────────────────────────
async function fetchPlaylist() {
  const res = await fetch(M3U_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── Parse M3U ─────────────────────────────────────
function parseM3U(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const channels = [];
  let i = 0;

  // Skip #EXTM3U header
  if (lines[0] && lines[0].startsWith('#EXTM3U')) i = 1;

  while (i < lines.length) {
    if (lines[i].startsWith('#EXTINF:')) {
      const infoLine = lines[i];
      i++;

      // Skip #EXTVLCOPT lines
      while (i < lines.length && lines[i].startsWith('#EXTVLCOPT')) i++;

      // Next non-comment line is the URL
      if (i < lines.length && !lines[i].startsWith('#')) {
        const url = lines[i];
        const channel = parseExtInf(infoLine, url);
        if (channel) channels.push(channel);
        i++;
      }
    } else {
      i++;
    }
  }

  return channels;
}

function parseExtInf(line, url) {
  // Extract tvg-logo
  const logoMatch = line.match(/tvg-logo="([^"]*)"/);
  const logo = logoMatch ? logoMatch[1] : '';

  // Extract group-title
  const groupMatch = line.match(/group-title="([^"]*)"/);
  const group = groupMatch ? groupMatch[1] : 'Uncategorized';

  // Extract channel name (after the last comma)
  const commaIdx = line.lastIndexOf(',');
  const name = commaIdx !== -1 ? line.substring(commaIdx + 1).trim() : 'Unknown';

  if (!name || !url) return null;

  return {
    id: generateId(name, url),
    name,
    url,
    logo,
    group,
    categories: group.split(';').map(c => c.trim()).filter(Boolean),
  };
}

function generateId(name, url) {
  let hash = 0;
  const str = name + url;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return 'ch_' + Math.abs(hash).toString(36);
}

// ─── Categories ────────────────────────────────────
function populateCategories() {
  const catSet = new Set();
  allChannels.forEach(ch => {
    ch.categories.forEach(c => {
      if (c && c !== 'Undefined') catSet.add(c);
    });
  });

  const sorted = [...catSet].sort((a, b) => a.localeCompare(b));
  sorted.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    dom.categorySelect.appendChild(opt);
  });
}

// ─── Filtering ─────────────────────────────────────
function applyFilters() {
  let source = allChannels;

  // Tab filter
  if (activeTab === 'favorites') {
    source = source.filter(ch => favorites.has(ch.id));
  }

  // Category filter
  if (activeCategory !== 'all') {
    source = source.filter(ch =>
      ch.categories.some(c => c.toLowerCase() === activeCategory.toLowerCase())
    );
  }

  // Search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    source = source.filter(ch =>
      ch.name.toLowerCase().includes(q) ||
      ch.group.toLowerCase().includes(q)
    );
  }

  filteredChannels = source;
  displayedCount = 0;
  dom.channelList.innerHTML = '';
  renderBatch();
  updateCount();
}

// ─── Rendering ─────────────────────────────────────
function renderBatch() {
  if (displayedCount >= filteredChannels.length) return;

  const end = Math.min(displayedCount + BATCH_SIZE, filteredChannels.length);
  const frag = document.createDocumentFragment();

  for (let i = displayedCount; i < end; i++) {
    frag.appendChild(createChannelItem(filteredChannels[i]));
  }

  dom.channelList.appendChild(frag);
  displayedCount = end;

  if (filteredChannels.length === 0) {
    showEmptyState();
  }
}

function createChannelItem(ch) {
  const div = document.createElement('div');
  div.className = 'channel-item' + (currentChannel && currentChannel.id === ch.id ? ' active' : '');
  div.dataset.id = ch.id;

  const isFav = favorites.has(ch.id);

  div.innerHTML = `
    ${ch.logo
      ? `<img class="channel-item-logo" src="${escapeAttr(ch.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'channel-item-logo-placeholder\\'>${escapeHtml(ch.name.substring(0,2))}</div>'">`
      : `<div class="channel-item-logo-placeholder">${escapeHtml(ch.name.substring(0, 2))}</div>`
    }
    <div class="channel-item-info">
      <div class="channel-item-name">${escapeHtml(ch.name)}</div>
      <div class="channel-item-category">${escapeHtml(ch.group)}</div>
    </div>
    <button class="channel-item-fav${isFav ? ' is-fav' : ''}" data-fav="${ch.id}" aria-label="Toggle favorite">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
    </button>
  `;

  // Click to play
  div.addEventListener('click', (e) => {
    if (e.target.closest('.channel-item-fav')) return;
    playChannel(ch);
    closeMobileMenu();
  });

  return div;
}

function showEmptyState() {
  dom.channelList.innerHTML = `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <div class="empty-state-title">No channels found</div>
      <div class="empty-state-sub">${activeTab === 'favorites' ? 'Add channels to favorites by clicking the heart icon' : 'Try adjusting your search or filters'}</div>
    </div>
  `;
}

function updateCount() {
  const total = filteredChannels.length;
  dom.channelCountText.textContent = `${total.toLocaleString()} channel${total !== 1 ? 's' : ''}`;
}

// ─── Playback ──────────────────────────────────────
function playChannel(ch) {
  currentChannel = ch;

  // UI updates
  dom.playerIdle.classList.add('hidden');
  dom.videoPlayer.classList.remove('hidden');
  dom.errorOverlay.classList.add('hidden');
  dom.bufferingOverlay.classList.remove('hidden');

  dom.nowPlayingName.textContent = ch.name;
  dom.channelNameDisplay.textContent = ch.name;

  // Logo
  if (ch.logo) {
    dom.channelLogoLarge.src = ch.logo;
    dom.channelLogoLarge.classList.add('visible');
  } else {
    dom.channelLogoLarge.classList.remove('visible');
  }

  // Tags
  dom.channelTags.innerHTML = ch.categories
    .map(c => `<span class="channel-tag">${escapeHtml(c)}</span>`)
    .join('');

  // Favorite button
  updateMainFavBtn();

  // Active state in list
  $$('.channel-item.active').forEach(el => el.classList.remove('active'));
  const activeEl = dom.channelList.querySelector(`[data-id="${ch.id}"]`);
  if (activeEl) activeEl.classList.add('active');

  // Start stream
  startStream(ch.url);
}

function startStream(url) {
  destroyHls();

  const video = dom.videoPlayer;

  if (url.includes('.m3u8') && Hls.isSupported()) {
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      startFragPrefetch: true,
    });

    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      dom.bufferingOverlay.classList.add('hidden');
    });

    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hlsInstance.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hlsInstance.recoverMediaError();
            break;
          default:
            showError('Stream failed to load');
            destroyHls();
            break;
        }
      }
    });

    hlsInstance.on(Hls.Events.FRAG_BUFFERED, () => {
      dom.bufferingOverlay.classList.add('hidden');
    });

  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    video.src = url;
    video.addEventListener('loadedmetadata', () => {
      video.play().catch(() => {});
      dom.bufferingOverlay.classList.add('hidden');
    }, { once: true });

  } else {
    // Try direct playback
    video.src = url;
    video.addEventListener('canplay', () => {
      video.play().catch(() => {});
      dom.bufferingOverlay.classList.add('hidden');
    }, { once: true });
  }

  // Shared video events
  video.onwaiting = () => dom.bufferingOverlay.classList.remove('hidden');
  video.onplaying = () => dom.bufferingOverlay.classList.add('hidden');
  video.onerror = () => showError('Stream unavailable or unsupported format');

  updatePlayPauseIcon();
}

function destroyHls() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
}

function showError(msg) {
  dom.errorText.textContent = msg;
  dom.errorOverlay.classList.remove('hidden');
  dom.bufferingOverlay.classList.add('hidden');
}

// ─── Controls ──────────────────────────────────────
function updatePlayPauseIcon() {
  const paused = dom.videoPlayer.paused;
  dom.playIcon.classList.toggle('hidden', !paused);
  dom.pauseIcon.classList.toggle('hidden', paused);
}

function updateVolumeIcon() {
  const muted = dom.videoPlayer.muted || dom.videoPlayer.volume === 0;
  dom.volumeIcon.classList.toggle('hidden', muted);
  dom.mutedIcon.classList.toggle('hidden', !muted);
}

// ─── Favorites ─────────────────────────────────────
function loadFavorites() {
  try {
    const data = localStorage.getItem(FAVORITES_KEY);
    if (data) favorites = new Set(JSON.parse(data));
  } catch {}
}

function saveFavorites() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}

function toggleFavorite(id) {
  if (favorites.has(id)) {
    favorites.delete(id);
  } else {
    favorites.add(id);
  }
  saveFavorites();

  // Update UI
  $$(`[data-fav="${id}"]`).forEach(btn => {
    btn.classList.toggle('is-fav', favorites.has(id));
  });

  if (currentChannel && currentChannel.id === id) {
    updateMainFavBtn();
  }

  // Re-filter if on favorites tab
  if (activeTab === 'favorites') applyFilters();
}

function updateMainFavBtn() {
  if (!currentChannel) return;
  const isFav = favorites.has(currentChannel.id);
  dom.favBtnMain.classList.toggle('is-fav', isFav);
}

// ─── Volume ────────────────────────────────────────
function loadVolume() {
  try {
    const v = localStorage.getItem(VOLUME_KEY);
    if (v !== null) {
      dom.videoPlayer.volume = parseFloat(v);
      dom.volumeSlider.value = parseFloat(v);
    }
  } catch {}
}

function saveVolume(v) {
  localStorage.setItem(VOLUME_KEY, v);
}

// ─── Mobile Menu ───────────────────────────────────
function openMobileMenu() {
  dom.sidebar.classList.add('mobile-open');
  dom.mobileOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
  dom.sidebar.classList.remove('mobile-open');
  dom.mobileOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

// ─── Show App ──────────────────────────────────────
function showApp() {
  dom.app.classList.remove('hidden');
  dom.loadingOverlay.classList.add('fade-out');
  setTimeout(() => {
    dom.loadingOverlay.style.display = 'none';
  }, 600);
}

// ─── Event Bindings ────────────────────────────────
function bindEvents() {
  // Sidebar toggle (desktop)
  dom.sidebarToggle.addEventListener('click', () => {
    dom.sidebar.classList.toggle('collapsed');
  });

  // Mobile menu
  dom.mobileMenuBtn.addEventListener('click', openMobileMenu);
  dom.mobileOverlay.addEventListener('click', closeMobileMenu);

  // Search
  let searchTimer;
  dom.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchQuery = dom.searchInput.value;
    dom.searchClear.classList.toggle('hidden', !searchQuery);
    searchTimer = setTimeout(() => applyFilters(), SEARCH_DEBOUNCE);
  });
  dom.searchClear.addEventListener('click', () => {
    dom.searchInput.value = '';
    searchQuery = '';
    dom.searchClear.classList.add('hidden');
    applyFilters();
    dom.searchInput.focus();
  });

  // Category tabs
  dom.tabAll.addEventListener('click', () => setTab('all'));
  dom.tabFavorites.addEventListener('click', () => setTab('favorites'));

  // Category select
  dom.categorySelect.addEventListener('change', () => {
    activeCategory = dom.categorySelect.value;
    applyFilters();
  });

  // Infinite scroll
  dom.channelList.addEventListener('scroll', () => {
    if (isLoadingMore) return;
    const { scrollTop, scrollHeight, clientHeight } = dom.channelList;
    if (scrollTop + clientHeight >= scrollHeight - 200) {
      isLoadingMore = true;
      renderBatch();
      isLoadingMore = false;
    }
  });

  // Favorite clicks (delegated)
  dom.channelList.addEventListener('click', (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      e.stopPropagation();
      toggleFavorite(favBtn.dataset.fav);
    }
  });

  // Main favorite button
  dom.favBtnMain.addEventListener('click', () => {
    if (currentChannel) toggleFavorite(currentChannel.id);
  });

  // Player controls
  dom.playPauseBtn.addEventListener('click', () => {
    const v = dom.videoPlayer;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    updatePlayPauseIcon();
  });

  dom.videoPlayer.addEventListener('play', updatePlayPauseIcon);
  dom.videoPlayer.addEventListener('pause', updatePlayPauseIcon);

  dom.muteBtn.addEventListener('click', () => {
    dom.videoPlayer.muted = !dom.videoPlayer.muted;
    updateVolumeIcon();
  });

  dom.volumeSlider.addEventListener('input', () => {
    const val = parseFloat(dom.volumeSlider.value);
    dom.videoPlayer.volume = val;
    dom.videoPlayer.muted = val === 0;
    updateVolumeIcon();
    saveVolume(val);
  });

  // Retry
  dom.retryBtn.addEventListener('click', () => {
    if (currentChannel) playChannel(currentChannel);
  });

  // PiP
  dom.pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await dom.videoPlayer.requestPictureInPicture();
      }
    } catch {}
  });

  // Fullscreen (both top-bar and in-player buttons)
  function toggleFullscreen() {
    const wrapper = dom.playerWrapper;
    if (!document.fullscreenElement) {
      (wrapper.requestFullscreen || wrapper.webkitRequestFullscreen || wrapper.msRequestFullscreen).call(wrapper);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
    }
  }

  dom.fullscreenBtn.addEventListener('click', toggleFullscreen);
  dom.fsControlBtn.addEventListener('click', toggleFullscreen);

  // Update fullscreen icons on change
  document.addEventListener('fullscreenchange', () => {
    const isFs = !!document.fullscreenElement;
    dom.fsEnterIcon.classList.toggle('hidden', isFs);
    dom.fsExitIcon.classList.toggle('hidden', !isFs);
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!dom.videoPlayer.classList.contains('hidden')) {
          dom.videoPlayer.paused ? dom.videoPlayer.play().catch(() => {}) : dom.videoPlayer.pause();
          updatePlayPauseIcon();
        }
        break;
      case 'm':
      case 'M':
        dom.videoPlayer.muted = !dom.videoPlayer.muted;
        updateVolumeIcon();
        break;
      case 'f':
      case 'F':
        dom.fullscreenBtn.click();
        break;
      case 'Escape':
        closeMobileMenu();
        break;
    }
  });
}

function setTab(tab) {
  activeTab = tab;
  dom.tabAll.classList.toggle('active', tab === 'all');
  dom.tabFavorites.classList.toggle('active', tab === 'favorites');
  applyFilters();
}

// ─── Utilities ─────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
