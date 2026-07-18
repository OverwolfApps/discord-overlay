let backgroundWindow = null;
let windowId = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getColorFromId(id) {
  if (!id) return '#7289da';
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 60%, 50%)`;
}

function updateVoiceHUD(state) {
  const server = state.guildName || '';
  document.getElementById('hud-server').textContent = server;
  document.getElementById('hud-channel').textContent = state.channelName || 'Not Connected';
  document.getElementById('hud-separator').style.display = server ? '' : 'none';

  // Apply header toggle display
  const header = document.querySelector('.hud-header');
  if (header) {
    header.style.display = backgroundWindow.appSettings.disableHeader ? 'none' : 'flex';
  }

  const voiceHud = document.getElementById('voice-hud');
  if (voiceHud) {
    if (backgroundWindow.appSettings.transparentBackground) {
      voiceHud.classList.add('transparent-bg');
    } else {
      voiceHud.classList.remove('transparent-bg');
    }
  }

  const usersList = document.getElementById('hud-users');

  if (!state.users || state.users.length === 0) {
    usersList.innerHTML = '<div style="color:rgba(194,195,197,0.4);font-size:11px;padding:6px 0;">No users in channel.</div>';
    return;
  }

  // Remove the placeholder if it exists
  if (usersList.children.length === 1 && !usersList.children[0].classList.contains('user-row')) {
    usersList.innerHTML = '';
  }

  const stateUserIds = new Set(state.users.map(u => u.id));

  // Remove left users
  Array.from(usersList.children).forEach(row => {
    if (row.classList.contains('user-row')) {
      const rowId = row.dataset.userId;
      if (!stateUserIds.has(rowId)) {
        row.remove();
      }
    }
  });

  const streamerMode = backgroundWindow.appSettings.streamerMode;

  // Update/Insert users
  state.users.forEach((user, idx) => {
    let row = usersList.querySelector(`.user-row[data-user-id="${user.id}"]`);
    const flagsHtml = [
      user.typing    ? `<span class="flag-badge typing"><span class="typing-dots"><span></span><span></span><span></span></span></span>` : '',
      user.video     ? `<span class="flag-badge video"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></span>` : '',
      user.streaming ? `<span class="flag-badge streaming"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7l-2 3v1h8v-1l-2-3h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 12H3V4h18v10z"/></svg></span>` : '',
      user.watching  ? `<span class="flag-badge watching"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg></span>` : '',
    ].filter(Boolean).join('');

    const statusBadgeHtml = user.deaf
      ? `<div class="status-badge deafen"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12v5c0 1.66 1.34 3 3 3h3v-8H4v-2c0-4.41 3.59-8 8-8s8 3.59 8 8v2h-4v8h3c1.66 0 3-1.34 3-3v-5c0-5.52-4.48-10-10-10z"/></svg></div>`
      : user.mute
        ? `<div class="status-badge mute"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg></div>`
        : '';

    let avatarHtml;
    if (streamerMode) {
      const bgColor = getColorFromId(user.id);
      avatarHtml = `
        <svg viewBox="0 0 24 24" class="user-avatar-placeholder" style="background-color: ${bgColor};">
          <path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
        </svg>
      `;
    } else {
      avatarHtml = `<img class="user-avatar" src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.username)}" onerror="this.style.display='none'" />`;
    }

    let nameHtml;
    if (streamerMode) {
      const name = String(user.username || '');
      if (name.length <= 2) {
        nameHtml = `<span class="blurred-text">${escapeHtml(name)}</span>`;
      } else {
        const first = name[0];
        const last = name[name.length - 1];
        const middle = name.slice(1, -1);
        nameHtml = `<span>${escapeHtml(first)}</span><span class="blurred-text">${escapeHtml(middle)}</span><span>${escapeHtml(last)}</span>`;
      }
    } else {
      nameHtml = escapeHtml(user.username);
    }

    if (!row) {
      row = document.createElement('div');
      row.className = 'user-row';
      row.dataset.userId = user.id;
      row.innerHTML = `
        <div class="avatar-container">
          ${avatarHtml}
          <div class="status-badge-wrapper">${statusBadgeHtml}</div>
        </div>
        <span class="user-name">${nameHtml}</span>
        <div class="user-flags-wrapper">${flagsHtml ? `<div class="user-flags">${flagsHtml}</div>` : ''}</div>
      `;
      
      if (idx >= usersList.children.length) {
        usersList.appendChild(row);
      } else {
        usersList.insertBefore(row, usersList.children[idx]);
      }
    } else {
      const avatarContainer = row.querySelector('.avatar-container');
      if (avatarContainer) {
        avatarContainer.innerHTML = `${avatarHtml}<div class="status-badge-wrapper">${statusBadgeHtml}</div>`;
      }

      const nameSpan = row.querySelector('.user-name');
      if (nameSpan && nameSpan.innerHTML !== nameHtml) {
        nameSpan.innerHTML = nameHtml;
      }

      const flagsWrapper = row.querySelector('.user-flags-wrapper');
      const newFlagsContent = flagsHtml ? `<div class="user-flags">${flagsHtml}</div>` : '';
      if (flagsWrapper && flagsWrapper.innerHTML !== newFlagsContent) {
        flagsWrapper.innerHTML = newFlagsContent;
      }

      if (usersList.children[idx] !== row) {
        usersList.insertBefore(row, usersList.children[idx]);
      }
    }

    if (user.speaking) {
      row.classList.add('speaking');
    } else {
      row.classList.remove('speaking');
    }
  });
}

function applySettings(settings) {
  document.body.style.display = settings.statusOverlayVisible !== false ? '' : 'none';
  
  const header = document.querySelector('.hud-header');
  if (header) {
    header.style.display = settings.disableHeader ? 'none' : 'flex';
  }

  updateVoiceHUD(backgroundWindow.rpcState);
}

document.addEventListener('DOMContentLoaded', () => {
  backgroundWindow = overwolf.windows.getMainWindow();

  overwolf.windows.getCurrentWindow(result => {
    windowId = result.window.id;
  });

  // Apply initial state
  updateVoiceHUD(backgroundWindow.rpcState);
  applySettings(backgroundWindow.appSettings);

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
  eventBus.addListener('settings-changed', applySettings);
});
