let backgroundWindow = null;
let windowId = null;

document.addEventListener('DOMContentLoaded', () => {
  backgroundWindow = overwolf.windows.getMainWindow();
  const eventBus = backgroundWindow.eventBus;

  overwolf.windows.getCurrentWindow(result => {
    windowId = result.window.id;
  });

  const bar = document.getElementById('voice-controls-bar');

  const btnMute = document.getElementById('btn-mute');
  const btnDeafen = document.getElementById('btn-deafen');
  const btnCamera = document.getElementById('btn-camera');
  const btnStream = document.getElementById('btn-stream');
  const btnSoundboard = document.getElementById('btn-soundboard');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const muteSlash = document.getElementById('mute-slash');
  const deafenSlash = document.getElementById('deafen-slash');
  const cameraSlash = document.getElementById('camera-slash');

  const soundboardPopup = document.getElementById('soundboard-popup');
  const soundGrid = document.getElementById('popup-sound-grid');
  const streamPopup = document.getElementById('stream-popup');

  applyVisibility(backgroundWindow.appSettings);
  updateDashboard(backgroundWindow.rpcState);

  // --- Drag (Overwolf native dragMove) ---
  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, input, select, .stream-popup, .soundboard-popup')) return;
    overwolf.windows.dragMove(windowId, () => {
      overwolf.windows.getCurrentWindow(r => {
        if (r.success) {
          backgroundWindow.saveSettings({ barX: r.window.left, barY: r.window.top });
        }
      });
    });
  });

  // --- Action bindings ---
  btnMute.addEventListener('click', () => backgroundWindow.toggleMute());
  btnDeafen.addEventListener('click', () => backgroundWindow.toggleDeafen());
  btnDisconnect.addEventListener('click', () => backgroundWindow.disconnectVoice());
  btnCamera.addEventListener('click', () => backgroundWindow.toggleCamera());
  document.getElementById('btn-settings').addEventListener('click', () => backgroundWindow.openSettings());

  btnStream.addEventListener('click', (e) => {
    e.stopPropagation();
    if (backgroundWindow.rpcState.selfStreaming) {
      streamPopup.classList.remove('show');
      backgroundWindow.stopStream();
    } else {
      streamPopup.classList.toggle('show');
      soundboardPopup.classList.remove('show');
    }
  });

  document.getElementById('btn-stream-game').addEventListener('click', (e) => {
    e.stopPropagation();
    streamPopup.classList.remove('show');
    backgroundWindow.startStream('game');
  });

  document.getElementById('btn-stream-screen').addEventListener('click', (e) => {
    e.stopPropagation();
    streamPopup.classList.remove('show');
    backgroundWindow.startStream('screen');
  });

  document.getElementById('btn-stream-stop').addEventListener('click', (e) => {
    e.stopPropagation();
    streamPopup.classList.remove('show');
    backgroundWindow.stopStream();
  });

  btnSoundboard.addEventListener('click', (e) => {
    e.stopPropagation();
    streamPopup.classList.remove('show');
    const isNowVisible = soundboardPopup.classList.toggle('show');
    if (isNowVisible) renderSoundboardGrid();
  });

  document.addEventListener('click', (e) => {
    if (!soundboardPopup.contains(e.target) && e.target !== btnSoundboard) {
      soundboardPopup.classList.remove('show');
    }
    if (!streamPopup.contains(e.target) && e.target !== btnStream) {
      streamPopup.classList.remove('show');
    }
  });

  eventBus.addListener('settings-changed', applyVisibility);
  eventBus.addListener('state-updated', updateDashboard);

  function applyVisibility(settings) {
    document.body.style.display = settings.dashboardOverlayVisible !== false ? '' : 'none';
  }

  function updateDashboard(state) {
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

    if (state.selfVideo) {
      btnCamera.classList.add('camera-on');
      btnCamera.classList.remove('active');
      cameraSlash.style.display = 'none';
    } else {
      btnCamera.classList.remove('camera-on');
      btnCamera.classList.add('active');
      cameraSlash.style.display = 'block';
    }

    if (state.selfStreaming) {
      btnStream.classList.add('streaming-on');
      btnStream.classList.remove('active');
    } else {
      btnStream.classList.remove('streaming-on');
      btnStream.classList.remove('active');
    }
  }

  function renderSoundboardGrid() {
    soundGrid.innerHTML = '';
    const sounds = backgroundWindow.rpcState.soundboardSounds;

    if (sounds && sounds.length > 0) {
      sounds.forEach(sound => {
        const btn = document.createElement('button');
        btn.className = 'popup-sound-btn';
        btn.innerHTML = `<span>${sound.emojiName}</span><span>${sound.name}</span>`;
        btn.addEventListener('click', () => {
          backgroundWindow.playSound(sound.soundId, sound.guildId);
        });
        soundGrid.appendChild(btn);
      });
    } else {
      soundGrid.innerHTML = `<div class="no-sounds" style="grid-column: 1 / -1; padding-top: 10px;">Join a voice channel.</div>`;
    }
  }
});
