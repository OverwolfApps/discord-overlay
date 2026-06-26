// Settings Window logic
let backgroundWindow = null;

document.addEventListener('DOMContentLoaded', async () => {
  backgroundWindow = overwolf.windows.getMainWindow();
  const eventBus = backgroundWindow.eventBus;

  // Initialize UI Drag-Move
  const dragHandle = document.getElementById('drag-handle');
  dragHandle.addEventListener('mousedown', () => {
    overwolf.windows.getCurrentWindow((result) => {
      if (result.status === 'success') {
        overwolf.windows.dragMove(result.window.id);
      }
    });
  });

  // Bind Close Window
  document.getElementById('close-btn').addEventListener('click', () => {
    overwolf.windows.getCurrentWindow((result) => {
      overwolf.windows.close(result.window.id);
    });
  });

  // UI elements
  const messageNotificationsToggle = document.getElementById('message-notifications-toggle');
  const eventNotificationsToggle = document.getElementById('event-notifications-toggle');
  const markdownToggle         = document.getElementById('markdown-toggle');
  const desktopOverlayToggle   = document.getElementById('desktop-overlay-toggle');
  const sliderH = document.getElementById('slider-horizontal');
  const sliderV = document.getElementById('slider-vertical');
  const sliderScale = document.getElementById('slider-scale');
  const sliderMaxNotifs = document.getElementById('slider-max-notifs');
  const sliderOpacity   = document.getElementById('slider-opacity');
  const inputH = document.getElementById('input-horizontal');
  const inputV = document.getElementById('input-vertical');
  const inputScale = document.getElementById('input-scale');
  const inputMaxNotifs = document.getElementById('input-max-notifs');
  const inputOpacity   = document.getElementById('input-opacity');
  const labelH = document.getElementById('slider-h-label');
  const labelV = document.getElementById('slider-v-label');

  const statusVal  = document.getElementById('discord-status');
  const serverVal   = document.getElementById('discord-guild-id');
  const channelVal  = document.getElementById('discord-channel-id');
  const soundboardGrid = document.getElementById('soundboard-grid');

  // 1. Sync controls with initial appSettings
  const settings = backgroundWindow.appSettings;
  messageNotificationsToggle.checked = settings.notificationsEnabled;
  eventNotificationsToggle.checked = settings.eventNotificationsEnabled;
  markdownToggle.checked       = settings.markdownEnabled ?? true;
  desktopOverlayToggle.checked = settings.overlayOnDesktop ?? false;
  sliderScale.value = settings.notificationScale || 1.0;
  inputScale.value = (settings.notificationScale || 1.0).toFixed(2);
  sliderMaxNotifs.value = settings.maxNotifications || 5;
  inputMaxNotifs.value = settings.maxNotifications || 5;
  const initialOpacityPct = Math.round((settings.notificationOpacity ?? 1.0) * 100);
  sliderOpacity.value = initialOpacityPct;
  inputOpacity.value = `${initialOpacityPct}%`;
  // Custom dropdown wiring
  const connectionModeInput   = document.getElementById('connection-mode');
  const connectionModeTrigger = document.getElementById('connection-mode-trigger');
  const connectionModeLabel   = document.getElementById('connection-mode-label');
  const connectionModeOptions = document.getElementById('connection-mode-options');

  const optionLabels = { rpc: 'Discord RPC (Direct)', bridge: 'Equicord Bridge Server', mock: 'Demo / Mock Mode' };

  function setConnectionMode(value) {
    connectionModeInput.value = value;
    connectionModeLabel.textContent = optionLabels[value] || value;
    document.querySelectorAll('.custom-option').forEach(o =>
      o.classList.toggle('active', o.dataset.value === value)
    );
  }

  // Open / close on trigger click
  connectionModeTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wrapper = document.getElementById('connection-mode-wrapper');
    wrapper.classList.toggle('open');
  });

  // Select an option
  connectionModeOptions.querySelectorAll('.custom-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const value = opt.dataset.value;
      setConnectionMode(value);
      document.getElementById('connection-mode-wrapper').classList.remove('open');
      backgroundWindow.changeConnectionMode(value);
    });
  });

  // Close on outside click
  document.addEventListener('click', () => {
    document.getElementById('connection-mode-wrapper')?.classList.remove('open');
  });

  // Init value
  setConnectionMode(settings.connectionMode);

  messageNotificationsToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ notificationsEnabled: e.target.checked });
  });

  eventNotificationsToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ eventNotificationsEnabled: e.target.checked });
  });

  markdownToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ markdownEnabled: e.target.checked });
  });

  desktopOverlayToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ overlayOnDesktop: e.target.checked });
  });

  // --- Preview lifecycle ---
  // Cards are created ONCE on first touch (mousedown) and cleared ~1.5s after release (mouseup).
  // During drag, only the window repositions via settings-changed → applySettings — no card redraw.
  let previewCleanupTimer = null;

  function startPreview() {
    clearTimeout(previewCleanupTimer);
    previewCleanupTimer = null;
    backgroundWindow.triggerPreviewNotifications();
  }

  function schedulePreviewCleanup() {
    clearTimeout(previewCleanupTimer);
    previewCleanupTimer = setTimeout(() => {
      backgroundWindow.clearPreviewNotifications();
    }, 1500);
  }

  // Overlay sliders: create preview on mousedown, schedule cleanup on mouseup
  [sliderH, sliderV, sliderScale, sliderMaxNotifs, sliderOpacity].forEach(slider => {
    slider.addEventListener('mousedown', startPreview);
    slider.addEventListener('mouseup',   schedulePreviewCleanup);
  });

  // Radio corners change
  document.querySelectorAll('input[name="screen-corner"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        backgroundWindow.saveSettings({ alignment: e.target.value });
        updateSliderLabels(e.target.value);
        startPreview();
        schedulePreviewCleanup();
      }
    });
  });

  // Sliders change — save settings only (window repositions via settings-changed event)
  sliderH.addEventListener('input', (e) => {
    inputH.value = e.target.value;
    backgroundWindow.saveSettings({ horizontalOffset: parseInt(e.target.value, 10) });
  });

  sliderV.addEventListener('input', (e) => {
    inputV.value = e.target.value;
    backgroundWindow.saveSettings({ verticalOffset: parseInt(e.target.value, 10) });
  });

  sliderScale.addEventListener('input', (e) => {
    const scale = parseFloat(e.target.value);
    inputScale.value = scale.toFixed(2);
    backgroundWindow.saveSettings({ notificationScale: scale });
  });

  sliderMaxNotifs.addEventListener('input', (e) => {
    const max = parseInt(e.target.value, 10);
    inputMaxNotifs.value = max;
    backgroundWindow.saveSettings({ maxNotifications: max });
    // Count changed → must recreate cards immediately
    backgroundWindow.triggerPreviewNotifications();
  });

  sliderOpacity.addEventListener('input', (e) => {
    const pct = parseInt(e.target.value, 10);
    inputOpacity.value = `${pct}%`;
    backgroundWindow.saveSettings({ notificationOpacity: pct / 100 });
  });

  // 3. Listen to EventBus updates from Background
  eventBus.addListener('settings-changed', (newSettings) => {
    setConnectionMode(newSettings.connectionMode);
    messageNotificationsToggle.checked = newSettings.notificationsEnabled;
    eventNotificationsToggle.checked = newSettings.eventNotificationsEnabled;
    markdownToggle.checked       = newSettings.markdownEnabled ?? true;
    desktopOverlayToggle.checked = newSettings.overlayOnDesktop ?? false;
    sliderH.value = newSettings.horizontalOffset;
    sliderV.value = newSettings.verticalOffset;
    sliderScale.value = newSettings.notificationScale || 1.0;
    sliderMaxNotifs.value = newSettings.maxNotifications || 5;
    inputH.value = newSettings.horizontalOffset;
    inputV.value = newSettings.verticalOffset;
    inputScale.value = (newSettings.notificationScale || 1.0).toFixed(2);
    inputMaxNotifs.value = newSettings.maxNotifications || 5;
    const newOpacityPct = Math.round((newSettings.notificationOpacity ?? 1.0) * 100);
    sliderOpacity.value = newOpacityPct;
    inputOpacity.value = `${newOpacityPct}%`;
    updateSliderLabels(newSettings.alignment);
    
    const rad = document.getElementById(`corner-${getCornerAbbreviation(newSettings.alignment)}`);
    if (rad) rad.checked = true;
  });

  eventBus.addListener('connection-status', (status) => {
    updateConnectionStatus(status);
  });

  eventBus.addListener('state-updated', (state) => {
    updateDiscordState(state);
  });



  // Initial Sync from State
  updateConnectionStatus(backgroundWindow.rpcState.authenticated ? 'authenticated' : (backgroundWindow.rpcState.connected ? 'connected' : 'disconnected'));
  updateDiscordState(backgroundWindow.rpcState);
});

// Help functions
function getCornerAbbreviation(align) {
  switch (align) {
    case 'topLeft': return 'tl';
    case 'topRight': return 'tr';
    case 'bottomLeft': return 'bl';
    case 'bottomRight': return 'br';
    default: return 'tl';
  }
}

function updateSliderLabels(alignment) {
  const labelH = document.getElementById('slider-h-label');
  const labelV = document.getElementById('slider-v-label');
  
  if (alignment.includes('Right')) {
    labelH.textContent = "Right Offset (px)";
  } else {
    labelH.textContent = "Left Offset (px)";
  }

  if (alignment.includes('bottom') || alignment.includes('Bottom')) {
    labelV.textContent = "Bottom Offset (px)";
  } else {
    labelV.textContent = "Top Offset (px)";
  }
}

function updateConnectionStatus(status) {
  const statusVal = document.getElementById('discord-status');
  statusVal.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  statusVal.className = 'status-value ' + status;
}

function updateDiscordState(state) {
  const serverVal  = document.getElementById('discord-guild-id');
  const channelVal = document.getElementById('discord-channel-id');
  const soundboardGrid = document.getElementById('soundboard-grid');

  serverVal.textContent  = state.guildId   || '-';
  channelVal.textContent = state.channelId || '-';

  // Render Soundboard sounds
  soundboardGrid.innerHTML = '';
  if (state.soundboardSounds && state.soundboardSounds.length > 0) {
    state.soundboardSounds.forEach(sound => {
      const btn = document.createElement('button');
      btn.className = 'sound-btn';
      btn.innerHTML = `
        <span class="sound-emoji">${sound.emojiName}</span>
        <span class="sound-name">${sound.name}</span>
      `;
      btn.addEventListener('click', () => {
        backgroundWindow.playSound(sound.soundId, sound.guildId);
      });
      soundboardGrid.appendChild(btn);
    });
  } else {
    soundboardGrid.innerHTML = '<div class="no-sounds">No soundboard sounds available. Please join a voice channel.</div>';
  }
}
