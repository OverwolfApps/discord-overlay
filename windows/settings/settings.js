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
  const externalNotificationsToggle = document.getElementById('external-notifications-toggle');
  const externalNotificationsPort   = document.getElementById('external-notifications-port');
  const externalPortRow             = document.getElementById('external-port-row');
  const markdownToggle           = document.getElementById('markdown-toggle');
  const desktopOverlayToggle     = document.getElementById('desktop-overlay-toggle');
  const statusOverlayToggle      = document.getElementById('status-overlay-toggle');
  const dashboardOverlayToggle   = document.getElementById('dashboard-overlay-toggle');
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


  // 1. Sync controls with initial appSettings
  const settings = backgroundWindow.appSettings;
  messageNotificationsToggle.checked = settings.notificationsEnabled;
  eventNotificationsToggle.checked   = settings.eventNotificationsEnabled;
  externalNotificationsToggle.checked = settings.useExternalNotifications === true;
  externalNotificationsPort.value     = settings.externalNotificationsPort || 61234;
  externalPortRow.style.display       = externalNotificationsToggle.checked ? '' : 'none';
  markdownToggle.checked             = settings.markdownEnabled ?? true;
  desktopOverlayToggle.checked       = settings.overlayOnDesktop ?? false;
  statusOverlayToggle.checked        = settings.statusOverlayVisible !== false;
  dashboardOverlayToggle.checked     = settings.dashboardOverlayVisible !== false;
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

  externalNotificationsToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ useExternalNotifications: e.target.checked });
    externalPortRow.style.display = e.target.checked ? '' : 'none';
  });

  externalNotificationsPort.addEventListener('change', (e) => {
    const p = parseInt(e.target.value, 10);
    if (p >= 1 && p <= 65535) backgroundWindow.saveSettings({ externalNotificationsPort: p });
  });

  markdownToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ markdownEnabled: e.target.checked });
  });

  desktopOverlayToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ overlayOnDesktop: e.target.checked });
  });

  statusOverlayToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ statusOverlayVisible: e.target.checked });
  });

  dashboardOverlayToggle.addEventListener('change', (e) => {
    backgroundWindow.saveSettings({ dashboardOverlayVisible: e.target.checked });
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

  // Radio corners change — also clears any saved drag position so corner takes effect
  document.querySelectorAll('input[name="screen-corner"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        backgroundWindow.saveSettings({ alignment: e.target.value, hudX: null, hudY: null });
        localStorage.removeItem('hudX');
        localStorage.removeItem('hudY');
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
    eventNotificationsToggle.checked   = newSettings.eventNotificationsEnabled;
    externalNotificationsToggle.checked = newSettings.useExternalNotifications === true;
    externalNotificationsPort.value     = newSettings.externalNotificationsPort || 61234;
    externalPortRow.style.display       = externalNotificationsToggle.checked ? '' : 'none';
    markdownToggle.checked             = newSettings.markdownEnabled ?? true;
    desktopOverlayToggle.checked       = newSettings.overlayOnDesktop ?? false;
    statusOverlayToggle.checked        = newSettings.statusOverlayVisible !== false;
    dashboardOverlayToggle.checked     = newSettings.dashboardOverlayVisible !== false;
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

  eventBus.addListener('connection-status', () => {
    renderStateViewer();
  });

  eventBus.addListener('state-updated', () => {
    renderStateViewer();
  });

  // Initial render
  renderStateViewer();
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

function renderStateViewer() {
  const viewer = document.getElementById('state-viewer');
  const badge  = document.getElementById('state-badge');
  if (!viewer) return;

  const state = backgroundWindow.rpcState;
  const settings = backgroundWindow.appSettings;

  const snapshot = {
    connection: {
      connected: state.connected,
      authenticated: state.authenticated,
      mode: settings.connectionMode,
    },
    voice: {
      guildId: state.guildId,
      guildName: state.guildName,
      channelId: state.channelId,
      channelName: state.channelName,
      selfMute: state.selfMute,
      selfDeaf: state.selfDeaf,
      selfStreaming: state.selfStreaming,
      selfVideo: state.selfVideo,
    },
    users: (state.users || []).map(u => ({
      id: u.id,
      username: u.username,
      mute: u.mute,
      deaf: u.deaf,
      speaking: u.speaking,
      video: u.video,
      streaming: u.streaming,
      watching: u.watching,
      typing: u.typing,
    })),
    soundboard: (state.soundboardSounds || []).map(s => ({ id: s.soundId, name: s.name, emoji: s.emojiName })),
  };

  const statusText = state.authenticated ? 'authenticated' : state.connected ? 'connected' : 'disconnected';
  badge.textContent = statusText;
  badge.className = 'state-badge ' + statusText;

  viewer.innerHTML = syntaxHighlight(JSON.stringify(snapshot, null, 2));
}

function syntaxHighlight(json) {
  return json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, match => {
      let cls = 'json-num';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-str';
      } else if (/true|false/.test(match)) {
        cls = 'json-bool';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return `<span class="${cls}">${match}</span>`;
    });
}
