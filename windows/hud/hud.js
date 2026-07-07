let backgroundWindow = null;
let windowId = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateVoiceHUD(state) {
  document.getElementById('hud-server').textContent = state.guildName || '-';
  document.getElementById('hud-channel').textContent = state.channelName || 'Not Connected';

  const usersList = document.getElementById('hud-users');
  usersList.innerHTML = '';

  if (state.users && state.users.length > 0) {
    state.users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'user-row' + (user.speaking ? ' speaking' : '');

      const flagsHtml = [
        user.typing    ? `<span class="flag-badge typing"><span class="typing-dots"><span></span><span></span><span></span></span></span>` : '',
        user.video     ? `<span class="flag-badge video"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></span>` : '',
        user.streaming ? `<span class="flag-badge streaming"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 6h16v2H4zm-2 4h20v2H2zm3 4h14v2H5z"/></svg></span>` : '',
        user.watching  ? `<span class="flag-badge watching"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg></span>` : '',
      ].filter(Boolean).join('');

      row.innerHTML = `
        <div class="avatar-container">
          <img class="user-avatar" src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.username)}" onerror="this.style.display='none'" />
          ${user.deaf
            ? `<div class="status-badge deafen"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12v5c0 1.66 1.34 3 3 3h3v-8H4v-2c0-4.41 3.59-8 8-8s8 3.59 8 8v2h-4v8h3c1.66 0 3-1.34 3-3v-5c0-5.52-4.48-10-10-10z"/></svg></div>`
            : user.mute
              ? `<div class="status-badge mute"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg></div>`
              : ''
          }
        </div>
        <span class="user-name">${escapeHtml(user.username)}</span>
        ${flagsHtml ? `<div class="user-flags">${flagsHtml}</div>` : ''}
      `;
      usersList.appendChild(row);
    });
  } else {
    usersList.innerHTML = '<div style="color:rgba(194,195,197,0.4);font-size:11px;padding:6px 0;">No users in channel.</div>';
  }
}

function applyVisibility(settings) {
  document.body.style.display = settings.statusOverlayVisible !== false ? '' : 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  backgroundWindow = overwolf.windows.getMainWindow();

  overwolf.windows.getCurrentWindow(result => {
    windowId = result.window.id;
  });

  // Apply initial state
  updateVoiceHUD(backgroundWindow.rpcState);
  applyVisibility(backgroundWindow.appSettings);

  // Drag: mousedown on HUD body (not on child elements we don't have here)
  const hud = document.getElementById('voice-hud');
  hud.addEventListener('mousedown', (e) => {
    overwolf.windows.dragMove(windowId, result => {
      // dragMove completes when user releases; save the new position
      overwolf.windows.getCurrentWindow(r => {
        if (r.success) {
          backgroundWindow.saveSettings({ hudX: r.window.left, hudY: r.window.top });
        }
      });
    });
  });

  const eventBus = backgroundWindow.eventBus;
  eventBus.addListener('state-updated', updateVoiceHUD);
  eventBus.addListener('settings-changed', applyVisibility);
});
