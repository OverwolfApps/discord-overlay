// Overlay Window Logic
let backgroundWindow = null;

document.addEventListener('DOMContentLoaded', () => {
  backgroundWindow = overwolf.windows.getMainWindow();
  const eventBus = backgroundWindow.eventBus;

  // DOM elements
  const hud = document.getElementById('voice-hud');
  const serverName = document.getElementById('hud-server');
  const channelName = document.getElementById('hud-channel');
  const usersList = document.getElementById('hud-users');
  const badge = document.getElementById('interactive-badge');

  const btnMute = document.getElementById('btn-mute');
  const btnDeafen = document.getElementById('btn-deafen');
  const btnSoundboard = document.getElementById('btn-soundboard');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const muteSlash = document.getElementById('mute-slash');
  const deafenSlash = document.getElementById('deafen-slash');

  const soundboardPopup = document.getElementById('soundboard-popup');
  const soundGrid = document.getElementById('popup-sound-grid');
  const notifContainer = document.getElementById('notifications-container');

  // 1. Initial Position and State sync
  applySettings(backgroundWindow.appSettings);
  updateVoiceHUD(backgroundWindow.rpcState);
  updateInteractiveState(backgroundWindow.controller.overlayInteractive);

  // 2. Action bindings
  btnMute.addEventListener('click', () => {
    backgroundWindow.toggleMute();
  });

  btnDeafen.addEventListener('click', () => {
    backgroundWindow.toggleDeafen();
  });

  btnDisconnect.addEventListener('click', () => {
    backgroundWindow.disconnectVoice();
  });

  // Soundboard Trigger
  btnSoundboard.addEventListener('click', (e) => {
    e.stopPropagation();
    soundboardPopup.classList.toggle('show');
    renderSoundboardGrid();
  });

  // Close soundboard popup on click outside
  document.addEventListener('click', (e) => {
    if (!soundboardPopup.contains(e.target) && e.target !== btnSoundboard) {
      soundboardPopup.classList.remove('show');
    }
  });

  // 3. Listeners from EventBus
  eventBus.addListener('settings-changed', (settings) => {
    applySettings(settings);
  });

  eventBus.addListener('state-updated', (state) => {
    updateVoiceHUD(state);
  });

  eventBus.addListener('overlay-interactive-changed', (interactive) => {
    updateInteractiveState(interactive);
  });


});

// Position updates
function applySettings(settings) {
  const hud = document.getElementById('voice-hud');
  
  hud.style.top = '';
  hud.style.left = '';
  hud.style.right = '';
  hud.style.bottom = '';

  const hOffset = `${settings.horizontalOffset}px`;
  const vOffset = `${settings.verticalOffset}px`;

  if (settings.alignment === 'topLeft') {
    hud.style.top = vOffset;
    hud.style.left = hOffset;
  } else if (settings.alignment === 'topRight') {
    hud.style.top = vOffset;
    hud.style.right = hOffset;
  } else if (settings.alignment === 'bottomLeft') {
    // Leave room for bottom control bar
    hud.style.bottom = `calc(${vOffset} + 60px)`;
    hud.style.left = hOffset;
  } else if (settings.alignment === 'bottomRight') {
    hud.style.bottom = `calc(${vOffset} + 60px)`;
    hud.style.right = hOffset;
  }
}

// Render users list
function updateVoiceHUD(state) {
  const serverName = document.getElementById('hud-server');
  const channelName = document.getElementById('hud-channel');
  const usersList = document.getElementById('hud-users');

  const btnMute = document.getElementById('btn-mute');
  const btnDeafen = document.getElementById('btn-deafen');
  const muteSlash = document.getElementById('mute-slash');
  const deafenSlash = document.getElementById('deafen-slash');

  serverName.textContent = state.guildName || '-';
  channelName.textContent = state.channelName || 'Not Connected';

  // Clear previous list
  usersList.innerHTML = '';

  if (state.users && state.users.length > 0) {
    state.users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'user-row';
      if (user.speaking) {
        row.classList.add('speaking');
      }

      const flagsHtml = [
        user.typing    ? `<span class="flag-badge typing" title="Typing"><span class="typing-dots"><span></span><span></span><span></span></span></span>` : '',
        user.video     ? `<span class="flag-badge video" title="Camera On"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></span>` : '',
        user.streaming ? `<span class="flag-badge streaming" title="Live Stream"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 6h16v2H4zm-2 4h20v2H2zm3 4h14v2H5z"/></svg></span>` : '',
        user.watching  ? `<span class="flag-badge watching" title="Watching Stream"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg></span>` : '',
      ].filter(Boolean).join('');

      row.innerHTML = `
        <div class="avatar-container">
          <img class="user-avatar" src="${user.avatarUrl}" alt="${user.username}" />
          ${user.deaf ? `
            <div class="status-badge deafen" title="Deafened">
              <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12v5c0 1.66 1.34 3 3 3h3v-8H4v-2c0-4.41 3.59-8 8-8s8 3.59 8 8v2h-4v8h3c1.66 0 3-1.34 3-3v-5c0-5.52-4.48-10-10-10z"/></svg>
            </div>` : 
            (user.mute ? `
            <div class="status-badge mute" title="Muted">
              <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
            </div>` : '')
          }
        </div>
        <span class="user-name">${user.username}</span>
        ${flagsHtml ? `<div class="user-flags">${flagsHtml}</div>` : ''}
      `;
      usersList.appendChild(row);
    });
  } else {
    usersList.innerHTML = '<div class="no-sounds" style="text-align: left; padding: 10px 0;">No users in channel.</div>';
  }

  // Update Mute/Deafen controls indicator bar
  if (state.selfMute) {
    btnMute.classList.add('active');
    muteSlash.style.display = 'block';
  } else {
    btnMute.classList.remove('active');
    muteSlash.style.display = 'none';
  }

  if (state.selfDeaf) {
    btnDeafen.classList.add('active');
    deafenSlash.style.display = 'block';
  } else {
    btnDeafen.classList.remove('active');
    deafenSlash.style.display = 'none';
  }
}

// Unlock / Unlock Mouse Pointer interaction State
function updateInteractiveState(interactive) {
  const badge = document.getElementById('interactive-badge');
  const bar = document.getElementById('voice-controls-bar');
  const popup = document.getElementById('soundboard-popup');
  const hud = document.getElementById('voice-hud');
  const btns = document.querySelectorAll('.control-btn, .popup-sound-btn');

  if (interactive) {
    document.body.classList.add('cursor-active');
    badge.style.display = 'block';
    
    // Add interactive class to clickable components
    bar.classList.add('interactive');
    popup.classList.add('interactive');
    hud.classList.add('interactive');
    btns.forEach(btn => btn.classList.add('interactive'));
  } else {
    document.body.classList.remove('cursor-active');
    badge.style.display = 'none';
    popup.classList.remove('show'); // Auto close soundboard popup when locking cursor
    
    // Remove interactive class
    bar.classList.remove('interactive');
    popup.classList.remove('interactive');
    hud.classList.remove('interactive');
    btns.forEach(btn => btn.classList.remove('interactive'));
  }
}

// Render soundboard dropdown menu
function renderSoundboardGrid() {
  const soundGrid = document.getElementById('popup-sound-grid');
  soundGrid.innerHTML = '';
  
  const sounds = backgroundWindow.rpcState.soundboardSounds;
  const isInteractive = backgroundWindow.controller.overlayInteractive;

  if (sounds && sounds.length > 0) {
    sounds.forEach(sound => {
      const btn = document.createElement('button');
      btn.className = 'popup-sound-btn';
      if (isInteractive) btn.classList.add('interactive');
      
      btn.innerHTML = `
        <span>${sound.emojiName}</span>
        <span>${sound.name}</span>
      `;
      btn.addEventListener('click', () => {
        backgroundWindow.playSound(sound.soundId, sound.guildId);
      });
      soundGrid.appendChild(btn);
    });
  } else {
    soundGrid.innerHTML = '<div class="no-sounds" style="grid-column: 1 / -1; padding-top: 10px;">Join a channel.</div>';
  }
}


