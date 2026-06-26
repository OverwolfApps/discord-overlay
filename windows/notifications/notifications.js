// Notifications Window Controller
let backgroundWindow = null;
let currentWindowId = null;

const WINDOW_W = 300;
// Height is always the full primary monitor height — set dynamically in applySettings
let WINDOW_H = 500;
const DISPLAY_MS = 5000;
const FADE_MS = 300;

document.addEventListener('DOMContentLoaded', () => {
  backgroundWindow = overwolf.windows.getMainWindow();
  const eventBus = backgroundWindow.eventBus;

  overwolf.windows.getCurrentWindow((result) => {
    if (result.status === 'success') {
      currentWindowId = result.window.id;
      // Start pass-through — no notifications yet
      setPassThrough(true);
      applySettings(backgroundWindow.appSettings);
    }
  });

  eventBus.addListener('settings-changed', (settings) => {
    applySettings(settings);
  });

  eventBus.addListener('notification', (notif) => {
    if (notif.isPreview) {
      const existing = document.querySelector('.ts-notif-card.preview-card');
      if (existing) {
        existing.classList.remove('fade-out');
        const bodyEl = existing.querySelector('.notif-body');
        if (bodyEl) bodyEl.textContent = notif.body;
        if (existing.dismissTimer) clearTimeout(existing.dismissTimer);
        scheduleCardDismiss(existing);
        return;
      }
    }
    showNotification(notif);
  });

  eventBus.addListener('fill-preview-notifications', ({ count, bodies, icons }) => {
    const stack = document.getElementById('notifications-stack');
    if (!stack) return;

    const existingCards = Array.from(stack.querySelectorAll('.preview-card'));

    // If the right number of cards is already showing, don't recreate —
    // just let the window reposition via the settings-changed → applySettings path.
    if (existingCards.length === count) {
      // Reset the safety auto-dismiss timer
      existingCards.forEach(c => {
        clearTimeout(c.safetyTimer);
        c.safetyTimer = setTimeout(() => dismissPreviewCard(c), 30000);
      });
      return;
    }

    // Count changed (e.g. maxNotifications slider moved): remove and recreate.
    existingCards.forEach(c => c.remove());

    const max = Math.min(count, bodies.length);
    for (let i = 0; i < max; i++) {
      showNotification({
        title: `Notification ${i + 1}`,
        body: bodies[i % bodies.length],
        icon: icons[i % icons.length],
        isPreview: true,
        isPersistent: true,
        safetyDismissMs: 30000 // fallback if clear event never fires
      });
    }
  });

  eventBus.addListener('clear-preview-notifications', () => {
    const stack = document.getElementById('notifications-stack');
    if (!stack) return;
    Array.from(stack.querySelectorAll('.preview-card')).forEach(c => dismissPreviewCard(c));
  });
});

// Helper: expose fill-preview to settings window via background
function triggerPreviewFromSettings() {
  const bw = overwolf.windows.getMainWindow();
  if (bw && bw.triggerPreviewNotifications) bw.triggerPreviewNotifications();
}

// --- Pass-through toggle ---
function setPassThrough(enabled) {
  if (!currentWindowId) return;
  if (enabled) {
    overwolf.windows.setWindowStyle(currentWindowId, 'InputPassThrough', () => {});
  } else {
    overwolf.windows.removeWindowStyle(currentWindowId, 'InputPassThrough', () => {});
  }
}

function updatePassThrough() {
  const stack = document.getElementById('notifications-stack');
  const hasCards = stack && stack.children.length > 0;
  setPassThrough(!hasCards);
}

// --- Settings / Positioning ---
function applySettings(settings) {
  const stack = document.getElementById('notifications-stack');
  if (!stack) return;

  const isBottom = settings.alignment.includes('bottom') || settings.alignment.includes('Bottom');

  stack.className = 'notifications-stack';
  stack.classList.add(settings.alignment.includes('Right') ? 'align-right' : 'align-left');
  stack.classList.add(isBottom ? 'flow-up' : 'flow-down');

  const scale = settings.notificationScale || 1.0;
  document.body.style.transform = `scale(${scale})`;
  // Transform origin must match the active corner so scaling expands AWAY from
  // the screen edge — cards stay pinned to their corner at any scale value.
  const isRight = settings.alignment.includes('Right');
  document.body.style.transformOrigin = `${isBottom ? 'bottom' : 'top'} ${isRight ? 'right' : 'left'}`;

  // Opacity — hover always restores full opacity (handled in CSS)
  const opacity = settings.notificationOpacity ?? 1.0;
  document.body.style.setProperty('--notif-opacity', opacity);

  const vOffset = settings.verticalOffset || 20;

  // For bottom corners: vOffset is applied as padding-bottom so the flex
  // anchor (bottom of the full-height window) is pushed up by vOffset px.
  // For top corners: vOffset is applied via window Y position, so reset padding.
  if (isBottom) {
    stack.style.paddingTop = '10px';
    stack.style.paddingBottom = `${vOffset}px`;
  } else {
    stack.style.paddingTop = '10px';
    stack.style.paddingBottom = '10px';
  }

  if (!currentWindowId) return;

  overwolf.utils.getMonitorsList((result) => {
    if (!result.success || !result.displays?.length) return;

    const display = result.displays.find(d => d.is_primary) || result.displays[0];
    const { width: screenW, height: screenH, x: screenX, y: screenY } = display;

    // Always use full screen height so any number of notifications fit
    WINDOW_H = screenH;

    const hOffset = settings.horizontalOffset || 20;

    const windowW = Math.round(WINDOW_W * scale);
    const windowH = WINDOW_H; // full height — vertical offset handled by padding/window-y

    let targetX = screenX, targetY = screenY;

    if (settings.alignment === 'topLeft') {
      targetX = screenX + hOffset;
      targetY = screenY + vOffset;
    } else if (settings.alignment === 'topRight') {
      targetX = screenX + screenW - windowW - hOffset;
      targetY = screenY + vOffset;
    } else if (settings.alignment === 'bottomLeft') {
      targetX = screenX + hOffset;
      targetY = screenY; // full-height window starts at screen top; padding-bottom handles gap
    } else if (settings.alignment === 'bottomRight') {
      targetX = screenX + screenW - windowW - hOffset;
      targetY = screenY; // full-height window starts at screen top; padding-bottom handles gap
    }

    overwolf.windows.changePosition(currentWindowId, targetX, targetY);
    overwolf.windows.changeSize({ window_id: currentWindowId, width: windowW, height: windowH });
  });
}

// --- Limited Markdown Parser (Discord subset) ---
// Supports: headings (#/##/###), bullet lists (- /*), numbered lists,
// bold, italic, underline, strikethrough, inline code, spoilers, line breaks.
// Gated behind appSettings.markdownEnabled — always HTML-escapes for safety.
function parseMarkdown(text) {
  if (!text) return '';

  // 1. HTML-escape raw input to prevent XSS
  let out = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // If markdown rendering is disabled, just convert newlines and return
  const markdownEnabled = backgroundWindow?.appSettings?.markdownEnabled ?? true;
  if (!markdownEnabled) {
    return out.replace(/\n/g, '<br>');
  }

  // 2. Process line-by-line for block-level elements
  const lines = out.split('\n');
  const result = [];
  let inList = false;
  let listType = null; // 'ul' or 'ol'

  const closeList = () => {
    if (inList) {
      result.push(`</${listType}>`);
      inList = false;
      listType = null;
    }
  };

  for (const line of lines) {
    // Headings: ### ## #
    const h3 = line.match(/^###\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    const h1 = line.match(/^#\s+(.+)/);
    // Bullet list: - or *
    const ul = line.match(/^[-*]\s+(.+)/);
    // Numbered list: 1. 2. etc.
    const ol = line.match(/^\d+\.\s+(.+)/);

    if (h3) {
      closeList();
      result.push(`<span class="md-h3">${h3[1]}</span>`);
    } else if (h2) {
      closeList();
      result.push(`<span class="md-h2">${h2[1]}</span>`);
    } else if (h1) {
      closeList();
      result.push(`<span class="md-h1">${h1[1]}</span>`);
    } else if (ul) {
      if (listType !== 'ul') { closeList(); result.push('<ul class="md-list">'); inList = true; listType = 'ul'; }
      result.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (listType !== 'ol') { closeList(); result.push('<ol class="md-list">'); inList = true; listType = 'ol'; }
      result.push(`<li>${ol[1]}</li>`);
    } else {
      closeList();
      result.push(line || '<br>');
    }
  }
  closeList();
  out = result.join('<br>');

  // 3. Apply inline markdown (order matters — longer tokens first)
  out = out
    // Spoiler: ||text||
    .replace(/\|\|(.+?)\|\|/g, '<span class="md-spoiler">$1</span>')
    // Bold: **text**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Underline: __text__
    .replace(/__(.+?)__/g, '<u>$1</u>')
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    // Italic: *text* or _text_
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    // Inline code: `code`
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');

  return out;
}

// --- Plain-text preview (for collapsed card) ---
// Strips all markdown syntax and collapses to a single line.
function markdownToPlainText(text) {
  if (!text) return '';
  return text
    .replace(/\|\|(.+?)\|\|/g, '$1')   // spoiler
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/__(.+?)__/g, '$1')        // underline
    .replace(/~~(.+?)~~/g, '$1')        // strikethrough
    .replace(/\*([^*]+)\*/g, '$1')      // italic *
    .replace(/_([^_]+)_/g, '$1')        // italic _
    .replace(/`([^`]+)`/g, '$1')        // inline code
    .replace(/^#{1,3}\s+/gm, '')        // headings
    .replace(/^[-*]\s+/gm, '\u2022 ')  // bullet list
    .replace(/^\d+\.\s+/gm, '')         // numbered list
    .replace(/\n+/g, ' ')               // newlines to spaces
    .trim();
}

// --- Notification Cards ---
function showNotification(notif) {
  const stack = document.getElementById('notifications-stack');
  if (!stack) return;

  // Enable hover interaction as soon as a card appears
  setPassThrough(false);

  const card = document.createElement('div');
  card.className = 'ts-notif-card';
  if (notif.isPreview) {
    card.classList.add('preview-card');
  }

  let iconSrc = '';
  let isAvatar = false;
  const body  = (notif.body  || '').toLowerCase();
  const title = (notif.title || '').toLowerCase();

  if (notif.icon && (notif.icon.startsWith('http') || notif.icon.startsWith('overwolf-extension'))) {
    iconSrc = notif.icon;
    isAvatar = true;
  } else if (body.includes('joined') || body.includes('connected') || title.includes('joined') || title.includes('connected')) {
    iconSrc = '../../images/NotificationEntered.png';
  } else if (body.includes('left') || body.includes('disconnected') || title.includes('left') || title.includes('disconnected')) {
    iconSrc = '../../images/NotificationHasLeft.png';
  } else {
    iconSrc = '../../images/NotificationTalking.png';
  }

  // Pre-compute both representations:
  // - bodyPreview: plain text for the collapsed single-line view
  // - bodyHtml:    full rendered markdown for the expanded hover view
  const bodyPreview = markdownToPlainText(notif.body);
  const bodyHtml    = parseMarkdown(notif.body);
  const titleHtml   = parseMarkdown(notif.title);

  card.innerHTML = `
    <div class="notif-icon-frame">
      <img class="notif-icon ${isAvatar ? 'notif-avatar' : ''}" src="${iconSrc}" alt="icon" onerror="this.style.display='none'" />
    </div>
    <div class="notif-text">
      <span class="notif-name">${titleHtml}</span>
      <span class="notif-body"></span>
    </div>
  `;

  // Set plain-text preview as the initial collapsed state
  const bodyEl = card.querySelector('.notif-body');
  bodyEl.textContent = bodyPreview;

  const max = backgroundWindow?.appSettings?.maxNotifications || 5;
  const isFlowUp = stack.classList.contains('flow-up');
  if (isFlowUp) {
    // In column-reverse the first DOM child appears at the bottom — prepend so
    // the newest card stays anchored at the corner and older ones rise above.
    stack.prepend(card);
    // Trim overflow from the far end (last DOM child = topmost visual card)
    while (stack.children.length > max) stack.lastChild.remove();
  } else {
    stack.appendChild(card);
    while (stack.children.length > max) stack.children[0].remove();
  }

  if (!notif.isPersistent) {
    scheduleCardDismiss(card);
  } else if (notif.safetyDismissMs) {
    // Safety fallback: auto-dismiss if clearPreviewNotifications never fires
    card.safetyTimer = setTimeout(() => dismissPreviewCard(card), notif.safetyDismissMs);
  }

  // Pause on hover, expand card to show full rendered markdown
  card.addEventListener('mouseenter', () => {
    clearTimeout(card.dismissTimer);
    card.dismissTimer = null;
    card.classList.add('expanded');
    bodyEl.innerHTML = bodyHtml;  // swap to full HTML on expand
  });

  card.addEventListener('mouseleave', () => {
    card.classList.remove('expanded');
    bodyEl.textContent = bodyPreview;  // revert to plain-text preview
    scheduleCardDismiss(card);
  });
}

function scheduleCardDismiss(card) {
  card.dismissTimer = setTimeout(() => {
    card.classList.add('fade-out');
    setTimeout(() => {
      card.remove();
      updatePassThrough(); // Re-enable pass-through if no cards left
    }, FADE_MS);
  }, DISPLAY_MS);
}

function dismissPreviewCard(card) {
  clearTimeout(card.dismissTimer);
  clearTimeout(card.safetyTimer);
  card.classList.add('fade-out');
  setTimeout(() => { card.remove(); updatePassThrough(); }, FADE_MS);
}
