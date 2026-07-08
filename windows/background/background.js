import { EventBus } from '../../scripts/event-bus.js';
import { WindowsService } from '../../scripts/windows-service.js';

const CLIENT_ID = '207646673902501888'; // Streamkit Client ID

// Strip the Discord markdown subset to plain text — the shared Notifications app renders plain text,
// not markdown, so **bold**/_italic_/`code` etc. shouldn't leak through as literal syntax.
function stripMarkdown(text) {
  if (!text) return '';
  return String(text)
    .replace(/\|\|(.+?)\|\|/g, '$1')   // spoiler
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/__(.+?)__/g, '$1')       // underline
    .replace(/~~(.+?)~~/g, '$1')       // strikethrough
    .replace(/\*([^*]+)\*/g, '$1')     // italic *
    .replace(/_([^_]+)_/g, '$1')       // italic _
    .replace(/`([^`]+)`/g, '$1')       // inline code
    .replace(/^#{1,3}\s+/gm, '');      // headings
}

class BackgroundController {
  constructor() {
    this.eventBus = new EventBus();
    window.eventBus = this.eventBus;

    // Global application state
    window.rpcState = {
      connected: false,
      authenticated: false,
      channelId: null,
      guildId: null,
      channelName: '',
      guildName: '',
      users: [],
      selfMute: false,
      selfDeaf: false,
      selfStreaming: false,
      selfVideo: false,
      soundboardSounds: []
    };

    // Global application settings (loaded from localStorage or defaults)
    window.appSettings = {
      alignment: localStorage.getItem('alignment') || 'topLeft',
      horizontalOffset: parseInt(localStorage.getItem('horizontalOffset') || '20', 10),
      verticalOffset: parseInt(localStorage.getItem('verticalOffset') || '20', 10),
      notificationsEnabled: localStorage.getItem('notificationsEnabled') !== 'false',
      eventNotificationsEnabled: localStorage.getItem('eventNotificationsEnabled') !== 'false',
      // Route notifications to the shared "Notifications" Overwolf app over its local HTTP endpoint
      // instead of this app's own overlay. Off by default → unchanged behavior.
      useExternalNotifications: localStorage.getItem('useExternalNotifications') === 'true',
      externalNotificationsPort: parseInt(localStorage.getItem('externalNotificationsPort') || '61234', 10),
      notificationScale: parseFloat(localStorage.getItem('notificationScale') || '1.0'),
      notificationOpacity: parseFloat(localStorage.getItem('notificationOpacity') ?? '1.0'),
      maxNotifications: parseInt(localStorage.getItem('maxNotifications') || '5', 10),
      markdownEnabled: localStorage.getItem('markdownEnabled') !== 'false',
      overlayOnDesktop: localStorage.getItem('overlayOnDesktop') === 'true',
      connectionMode: localStorage.getItem('connectionMode') || 'rpc', // 'rpc', 'bridge', 'mock'
      statusOverlayVisible: localStorage.getItem('statusOverlayVisible') !== 'false',
      dashboardOverlayVisible: localStorage.getItem('dashboardOverlayVisible') !== 'false',
      hudX: localStorage.getItem('hudX') !== null ? parseInt(localStorage.getItem('hudX'), 10) : null,
      hudY: localStorage.getItem('hudY') !== null ? parseInt(localStorage.getItem('hudY'), 10) : null,
      barX: localStorage.getItem('barX') !== null ? parseInt(localStorage.getItem('barX'), 10) : null,
      barY: localStorage.getItem('barY') !== null ? parseInt(localStorage.getItem('barY'), 10) : null
    };

    this.ws = null;
    this.token = localStorage.getItem('discord_token') || null;
    this.reconnectTimeout = null;
    this.mockInterval = null;
    this.typingTimers = {}; // userId → setTimeout handle for typing expiry

    // C# WebSocket Server Plugin
    this.bridgePlugin = null;
    this.bridgeUserId = null;

    // Notifications that arrive before CHANNEL_JOINED is processed are queued
    // and flushed once the channel state is ready.
    this.pendingNotifications = [];
    this.channelReady = false;
    this.channelReadyFlushTimer = null;
  }

  async run() {
    this.initCentralSettings();
    // 1. Load initial settings
    this.eventBus.trigger('settings-changed', window.appSettings);

    // 2. Initialize Overwolf window controllers
    await WindowsService.restore('notifications');
    await WindowsService.setTopmost('notifications', true);

    // Always open the HUD/dashboard immediately — they render on desktop and in-game alike.
    // checkGameStatus will still close them if a game exits and overlayOnDesktop is off.
    // Windows are never click-through: Overwolf's own in-game menu key already governs
    // whether mouse input goes to the game or the overlay, so we don't manage that ourselves.
    await WindowsService.restore('hud');
    await WindowsService.changeSize('hud', 260, 400).catch(e => console.warn('changeSize hud failed', e));
    await WindowsService.setTopmost('hud', true);
    await WindowsService.restore('dashboard');
    await WindowsService.changeSize('dashboard', 420, 360).catch(e => console.warn('changeSize dashboard failed', e));
    await WindowsService.setTopmost('dashboard', true);
    await this.positionOverlayWindows();

    // Watch for game launch/exit to manage overlay visibility
    this.checkGameStatus();
    overwolf.games.onGameInfoUpdated.addListener(() => this.checkGameStatus());

    // Initialize C# Bridge Plugin for websocket mode
    this.initBridgePlugin();

    // 3. Setup Discord connection based on mode
    this.startActiveMode();

    // Bind state mutation methods on window
    window.toggleMute = () => this.toggleMute();
    window.toggleDeafen = () => this.toggleDeafen();
    window.disconnectVoice = () => this.disconnectVoice();
    window.playSound = (soundId, guildId) => this.playSound(soundId, guildId);
    window.saveSettings = (settings) => this.saveSettings(settings);
    window.changeConnectionMode = (mode) => this.changeConnectionMode(mode);
    window.triggerPreviewNotifications = () => this.triggerPreviewNotifications();
    window.clearPreviewNotifications = () => this.clearPreviewNotifications();
    window.openSettings = () => this.openSettings();
    window.startStream = (source) => this.startStream(source);
    window.stopStream = () => this.stopStream();
    window.toggleCamera = () => this.toggleCamera();

    overwolf.windows.onMessageReceived.addListener((msg) => {
      if (msg.id === 'shutdown-app') {
        console.log('[discord-overlay] Received shutdown command from Settings Manager.');
        window.close();
      } else if (msg.id === 'set-autostart') {
        console.log('[discord-overlay] Received set-autostart command from Settings Manager:', msg.content.enabled);
        overwolf.settings.setExtensionSettings({ auto_launch_with_overwolf: msg.content.enabled !== false }, () => {});
      }
    });
  }

  initBridgePlugin() {
    try {
      overwolf.extensions.current.getExtraObject("websocket-server-plugin", (result) => {
        if (result.status === "success") {
          this.bridgePlugin = result.object;
          this.bridgePlugin.OnMessage.addListener((msg) => this.handleBridgeMessage(msg));
          this.bridgePlugin.OnStatus.addListener((status) => this.handleBridgeStatus(status));
          console.log("C# WebSocket Server Plugin loaded successfully.");
          if (window.appSettings.connectionMode === 'bridge') {
            this.startBridgeServer();
          }
        } else {
          console.error("Failed to load C# WebSocket Server Plugin:", result);
        }
      });
    } catch (e) {
      console.error("Error loading C# WebSocket Server Plugin:", e);
    }
  }

  // Clamp a window's top-left so it can't end up fully or mostly off-screen
  // (guards against stale saved positions from before a window was resized).
  clampToScreen(left, top, winW, winH) {
    const availW = screen.availWidth || 1920;
    const availH = screen.availHeight || 1080;
    return {
      left: Math.min(Math.max(left, 0), Math.max(0, availW - winW)),
      top: Math.min(Math.max(top, 0), Math.max(0, availH - winH)),
    };
  }

  // Position HUD and Dashboard windows on screen using saved drag coords or corner-based defaults
  async positionOverlayWindows() {
    const settings = window.appSettings;

    if (settings.hudX !== null && settings.hudX !== undefined) {
      const pos = this.clampToScreen(settings.hudX, settings.hudY, 260, 400);
      await WindowsService.changePosition('hud', pos.left, pos.top)
        .catch(e => console.warn('positionOverlayWindows: hud changePosition failed', e));
    } else {
      const offset = await this.getCornerPosition(settings.alignment, settings.horizontalOffset, settings.verticalOffset, 'hud');
      await WindowsService.changePosition('hud', offset.left, offset.top)
        .catch(e => console.warn('positionOverlayWindows: hud changePosition failed', e));
    }

    if (settings.barX !== null && settings.barX !== undefined) {
      const pos = this.clampToScreen(settings.barX, settings.barY, 420, 360);
      await WindowsService.changePosition('dashboard', pos.left, pos.top)
        .catch(e => console.warn('positionOverlayWindows: dashboard changePosition failed', e));
    } else {
      const screenLeft = (screen.availWidth || 1920) / 2 - 210;
      const screenTop = (screen.availHeight || 1080) - 380;
      await WindowsService.changePosition('dashboard', Math.round(screenLeft), Math.round(screenTop))
        .catch(e => console.warn('positionOverlayWindows: dashboard changePosition failed', e));
    }
  }

  async getCornerPosition(alignment, hOffset, vOffset, windowName) {
    const availW = screen.availWidth || 1920;
    const availH = screen.availHeight || 1080;
    const winW = windowName === 'hud' ? 260 : 420;
    const winH = windowName === 'hud' ? 400 : 360;

    switch (alignment) {
      case 'topRight':
        return { left: availW - winW - hOffset, top: vOffset };
      case 'bottomLeft':
        return { left: hOffset, top: availH - winH - vOffset };
      case 'bottomRight':
        return { left: availW - winW - hOffset, top: availH - winH - vOffset };
      case 'topLeft':
      default:
        return { left: hOffset, top: vOffset };
    }
  }

  async checkGameStatus() {
    overwolf.games.getRunningGameInfo(async (gameInfo) => {
      const isGameRunning = gameInfo && gameInfo.isRunning;
      const showOnDesktop = window.appSettings.overlayOnDesktop;

      if (window.appSettings.closeOnGameExit && !isGameRunning) {
        console.log('[discord-overlay] closeOnGameExit enabled and no game running. Shutting down.');
        window.close();
        return;
      }

      const hudState = await WindowsService.getWindowState('hud');
      const dashState = await WindowsService.getWindowState('dashboard');

      if (isGameRunning || showOnDesktop) {
        let restored = false;
        if (hudState === 'closed' || hudState === 'hidden') {
          await WindowsService.restore('hud');
          await WindowsService.changeSize('hud', 260, 400).catch(e => console.warn('changeSize hud failed', e));
          await WindowsService.setTopmost('hud', true);
          restored = true;
        }
        if (dashState === 'closed' || dashState === 'hidden') {
          await WindowsService.restore('dashboard');
          await WindowsService.changeSize('dashboard', 420, 360).catch(e => console.warn('changeSize dashboard failed', e));
          await WindowsService.setTopmost('dashboard', true);
          restored = true;
        }
        if (restored) await this.positionOverlayWindows();
      } else {
        if (hudState !== 'closed') await WindowsService.close('hud');
        if (dashState !== 'closed') await WindowsService.close('dashboard');
      }
    });
  }

  // --- SETTINGS CONTROL API ---
  saveSettings(newSettings) {
    Object.assign(window.appSettings, newSettings);
    for (const [key, val] of Object.entries(newSettings)) {
      localStorage.setItem(key, String(val));
    }
    this.eventBus.trigger('settings-changed', window.appSettings);
    // Immediately apply overlay visibility when the desktop toggle changes
    if ('overlayOnDesktop' in newSettings) {
      this.checkGameStatus();
    }

    // Sync back to central settings if active
    fetch('http://localhost:61235/set?app=Discord%20Overlay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: newSettings })
    }).catch(() => {});
  }

  changeConnectionMode(mode) {
    this.saveSettings({ connectionMode: mode });
    this.startActiveMode();
  }

  // Replace <@userId> and <@!userId> mentions with display names from voice state.
  // Falls back to '@user' for unknown IDs so raw snowflakes never reach the UI.
  resolveMentions(text) {
    if (!text) return text;
    return text.replace(/<@!?(\d+)>/g, (match, id) => {
      const user = window.rpcState.users.find(u => u.id === id);
      return user ? `@${user.username}` : '@user';
    });
  }

  flushPendingNotifications() {
    clearTimeout(this.channelReadyFlushTimer);
    this.channelReadyFlushTimer = null;
    this.channelReady = true;
    for (const notif of this.pendingNotifications) {
      this.sendNotification(notif);
    }
    this.pendingNotifications = [];
  }

  emitNotification(notif) {
    notif = { ...notif, body: this.resolveMentions(notif.body), title: this.resolveMentions(notif.title) };
    if (!this.channelReady) {
      this.pendingNotifications.push(notif);
      // Safety flush — if CHANNEL_JOINED never arrives, show after 2s
      if (!this.channelReadyFlushTimer) {
        this.channelReadyFlushTimer = setTimeout(() => this.flushPendingNotifications(), 2000);
      }
    } else {
      this.sendNotification(notif);
    }
  }

  // Single chokepoint for every real notification. When the user has enabled it, hand the
  // notification to the shared "Notifications" app over HTTP; otherwise show it in this app's own
  // overlay (the original behavior). Previews always stay local so tuning the overlay still works.
  sendNotification(notif) {
    if (window.appSettings.useExternalNotifications && !notif.isPreview) {
      this.postExternalNotification(notif);
    } else {
      this.eventBus.trigger('notification', notif);
    }
  }

  postExternalNotification(notif) {
    const port = window.appSettings.externalNotificationsPort || 61234;
    const icon = (notif.icon && (notif.icon.startsWith('http') || notif.icon.startsWith('overwolf-extension')))
      ? notif.icon : undefined;
    const payload = {
      app: 'Discord',
      title: notif.title || 'Discord',
      message: stripMarkdown(notif.body || ''),
      icon,
      // Corner/timeout are left to the Notifications app so the USER controls placement there;
      // this app just sends content.
    };
    fetch(`http://localhost:${port}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((e) => {
      // If the Notifications app isn't running/reachable, fall back to the local overlay so
      // notifications are never silently dropped.
      console.warn('[discord] external notify failed, using local overlay:', e && e.message);
      this.eventBus.trigger('notification', notif);
    });
  }

  startActiveMode() {
    const mode = window.appSettings.connectionMode;
    console.log(`Switching connection mode to: ${mode}`);

    // Disconnect everything first
    this.stopMockSimulation();
    this.disconnectDiscordSocket();
    this.stopBridgeServer();

    if (mode === 'mock') {
      this.startMockSimulation();
    } else if (mode === 'bridge') {
      this.startBridgeServer();
    } else {
      this.connectDiscord();
    }
  }

  // --- DISCORD RPC CLIENT (ws://127.0.0.1:6463) ---
  connectDiscord() {
    this.eventBus.trigger('connection-status', 'connecting');
    this.tryPorts(6463);
  }

  disconnectDiscordSocket() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch(e) {}
      this.ws = null;
    }
    window.rpcState.connected = false;
    window.rpcState.authenticated = false;
    this.clearVoiceState();
    this.eventBus.trigger('state-updated', window.rpcState);
    this.channelReady = false;
    this.pendingNotifications = [];
  }

  async tryPorts(port) {
    if (window.appSettings.connectionMode !== 'rpc') return;
    if (port > 6472) {
      console.warn("Could not find Discord RPC local WebSocket.");
      this.eventBus.trigger('connection-status', 'disconnected');
      this.reconnectTimeout = setTimeout(() => this.connectDiscord(), 10000);
      return;
    }

    try {
      const success = await this.tryConnect(port);
      if (success) {
        console.log(`Successfully connected to Discord RPC on port ${port}`);
        return;
      }
    } catch(e) {
      this.tryPorts(port + 1);
    }
  }

  tryConnect(port) {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(`wss://localhost.discord.media:${port}/?v=1&client_id=${CLIENT_ID}&origin=https://streamkit.discord.com`);

      ws.onopen = () => {
        opened = true;
        this.ws = ws;
        this.setupSocketHandlers();
        window.rpcState.connected = true;
        this.eventBus.trigger('connection-status', 'connected');
        resolve(true);
      };

      ws.onerror = (e) => {
        if (!opened) {
          reject(new Error("Connection refused"));
        }
      };

      setTimeout(() => {
        if (!opened) {
          ws.close();
          reject(new Error("Timeout"));
        }
      }, 1000);
    });
  }

  setupSocketHandlers() {
    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
        if (this.token) {
          this.authenticate();
        } else {
          this.authorize();
        }
      } else if (msg.cmd === 'AUTHENTICATE') {
        if (msg.evt === 'ERROR') {
          console.warn("Auth token invalid, starting new OAuth flow.");
          this.token = null;
          localStorage.removeItem('discord_token');
          this.authorize();
        } else {
          console.log("Authenticated successfully via RPC!");
          window.rpcState.authenticated = true;
          this.eventBus.trigger('connection-status', 'authenticated');
          
          this.send('SUBSCRIBE', {}, 'VOICE_CHANNEL_SELECT');
          this.send('GET_SELECTED_VOICE_CHANNEL');
          this.send('GET_SOUNDBOARD_SOUNDS');
        }
      } else if (msg.cmd === 'AUTHORIZE') {
        if (msg.evt === 'ERROR') {
          console.error("Authorization failed:", msg);
          this.eventBus.trigger('connection-status', 'error');
        } else {
          const code = msg.data.code;
          await this.exchangeToken(code);
        }
      } else if (msg.cmd === 'DISPATCH') {
        this.handleDispatch(msg.evt, msg.data);
      } else if (msg.cmd === 'GET_SELECTED_VOICE_CHANNEL' || msg.cmd === 'SELECT_VOICE_CHANNEL') {
        if (msg.data && msg.data.id) {
          this.joinVoiceChannel(msg.data.id, msg.data.guild_id);
        } else {
          this.clearVoiceState();
          this.eventBus.trigger('state-updated', window.rpcState);
        }
      } else if (msg.cmd === 'GET_CHANNEL') {
        if (msg.data) {
          window.rpcState.channelName = msg.data.name;
          window.rpcState.users = msg.data.voice_states.map(vs => this.mapVoiceState(vs));
          this.eventBus.trigger('state-updated', window.rpcState);
          this.flushPendingNotifications();
        }
      } else if (msg.cmd === 'GET_GUILD') {
        if (msg.data) {
          window.rpcState.guildName = msg.data.name;
          this.eventBus.trigger('state-updated', window.rpcState);
        }
      } else if (msg.cmd === 'GET_SOUNDBOARD_SOUNDS') {
        if (msg.data && msg.data.soundboard_sounds) {
          window.rpcState.soundboardSounds = msg.data.soundboard_sounds.map(s => ({
            soundId: s.sound_id,
            name: s.name,
            volume: s.volume,
            guildId: s.guild_id,
            emojiName: s.emoji_name || '🔊'
          }));
          this.eventBus.trigger('state-updated', window.rpcState);
        }
      }
    };

    this.ws.onclose = () => {
      console.warn("Discord RPC socket closed.");
      this.disconnectDiscordSocket();
      if (window.appSettings.connectionMode === 'rpc') {
        this.reconnectTimeout = setTimeout(() => this.connectDiscord(), 10000);
      }
    };
  }

  authorize() {
    this.send('AUTHORIZE', {
      client_id: CLIENT_ID,
      scopes: ['rpc', 'rpc.voice.write', 'messages.read', 'rpc.notifications.read'],
      prompt: 'none'
    });
  }

  authenticate() {
    this.send('AUTHENTICATE', { access_token: this.token });
  }

  async exchangeToken(code) {
    try {
      const resp = await fetch('https://streamkit.discord.com/overlay/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      if (!resp.ok) throw new Error("Failed to post OAuth token exchange.");
      const res = await resp.json();
      if (res.access_token) {
        this.token = res.access_token;
        localStorage.setItem('discord_token', this.token);
        this.authenticate();
      }
    } catch(e) {
      console.error("Token exchange failed:", e);
      this.eventBus.trigger('connection-status', 'error');
    }
  }

  handleDispatch(evt, data) {
    switch (evt) {
      case 'VOICE_CHANNEL_SELECT':
        if (data.channel_id) {
          this.joinVoiceChannel(data.channel_id, data.guild_id);
        } else {
          this.clearVoiceState();
          this.eventBus.trigger('state-updated', window.rpcState);
        }
        break;
      case 'VOICE_STATE_CREATE':
      case 'VOICE_STATE_UPDATE':
        const updatedUser = this.mapVoiceState(data);
        const index = window.rpcState.users.findIndex(u => u.id === updatedUser.id);
        if (index >= 0) {
          const prevUser = Object.assign({}, window.rpcState.users[index]);
          window.rpcState.users[index] = Object.assign(window.rpcState.users[index], updatedUser);
          this.checkUserEventNotifications(prevUser, window.rpcState.users[index]);
        } else {
          window.rpcState.users.push(updatedUser);
          this.checkUserEventNotifications(null, updatedUser);
        }
        this.eventBus.trigger('state-updated', window.rpcState);
        break;
      case 'VOICE_STATE_DELETE':
        const leavingUser = window.rpcState.users.find(u => u.id === data.user.id);
        if (leavingUser) {
          this.checkUserEventNotifications(leavingUser, null);
        }
        window.rpcState.users = window.rpcState.users.filter(u => u.id !== data.user.id);
        this.eventBus.trigger('state-updated', window.rpcState);
        break;
      case 'SPEAKING_START':
        this.setSpeaking(data.user_id, true);
        break;
      case 'SPEAKING_STOP':
        this.setSpeaking(data.user_id, false);
        break;
      case 'VOICE_SETTINGS_UPDATE':
        window.rpcState.selfMute = data.mute;
        window.rpcState.selfDeaf = data.deaf;
        this.eventBus.trigger('state-updated', window.rpcState);
        break;
      case 'NOTIFICATION_CREATE':
        if (window.appSettings.notificationsEnabled) {
          this.emitNotification({
            title: data.title || "Notification",
            body: data.body || "",
            icon: data.icon_url || ""
          });
        }
        break;
    }
  }

  joinVoiceChannel(channelId, guildId) {
    if (window.rpcState.channelId && window.rpcState.channelId !== channelId) {
      this.send('UNSUBSCRIBE', {}, 'VOICE_STATE_CREATE', { channel_id: window.rpcState.channelId });
      this.send('UNSUBSCRIBE', {}, 'VOICE_STATE_UPDATE', { channel_id: window.rpcState.channelId });
      this.send('UNSUBSCRIBE', {}, 'VOICE_STATE_DELETE', { channel_id: window.rpcState.channelId });
      this.send('UNSUBSCRIBE', {}, 'SPEAKING_START', { channel_id: window.rpcState.channelId });
      this.send('UNSUBSCRIBE', {}, 'SPEAKING_STOP', { channel_id: window.rpcState.channelId });
    }

    window.rpcState.channelId = channelId;
    window.rpcState.guildId = guildId;

    this.send('SUBSCRIBE', {}, 'VOICE_STATE_CREATE', { channel_id: channelId });
    this.send('SUBSCRIBE', {}, 'VOICE_STATE_UPDATE', { channel_id: channelId });
    this.send('SUBSCRIBE', {}, 'VOICE_STATE_DELETE', { channel_id: channelId });
    this.send('SUBSCRIBE', {}, 'SPEAKING_START', { channel_id: channelId });
    this.send('SUBSCRIBE', {}, 'SPEAKING_STOP', { channel_id: channelId });

    this.send('GET_CHANNEL', { channel_id: channelId });
    if (guildId) {
      this.send('GET_GUILD', { guild_id: guildId });
    } else {
      window.rpcState.guildName = 'Direct Message';
    }
  }

  checkUserEventNotifications(prev, curr) {
    if (!window.appSettings.eventNotificationsEnabled) return;

    const channelName = window.rpcState.channelName ? `#${window.rpcState.channelName}` : 'the channel';

    // 1. User Joined
    if (!prev && curr) {
      this.triggerEventNotification(`@${curr.username} joined ${channelName}`, curr.avatarUrl);
    }
    // 2. User Left
    else if (prev && !curr) {
      this.triggerEventNotification(`@${prev.username} left ${channelName}`, prev.avatarUrl);
    }
    // 3. Status changes (streaming, video)
    else if (prev && curr) {
      if (!prev.streaming && curr.streaming) {
        this.triggerEventNotification(`@${curr.username} started streaming`, curr.avatarUrl);
      } else if (prev.streaming && !curr.streaming) {
        this.triggerEventNotification(`@${curr.username} stopped streaming`, curr.avatarUrl);
      }

      if (!prev.video && curr.video) {
        this.triggerEventNotification(`@${curr.username} enabled their camera`, curr.avatarUrl);
      } else if (prev.video && !curr.video) {
        this.triggerEventNotification(`@${curr.username} disabled their camera`, curr.avatarUrl);
      }

      if (!prev.typing && curr.typing) {
        this.triggerEventNotification(`@${curr.username} started typing`, curr.avatarUrl);
      } else if (prev.typing && !curr.typing) {
        this.triggerEventNotification(`@${curr.username} stopped typing`, curr.avatarUrl);
      }
    }
  }

  triggerEventNotification(message, iconUrl) {
    this.sendNotification({
      title: "Event Notification",
      body: message,
      icon: iconUrl || ""
    });
  }

  triggerPreviewNotification() {
    this.eventBus.trigger('notification', {
      title: "Notification Scale Preview",
      body: "Drag the slider to adjust the notification size.",
      icon: "../../images/NotificationTalking.png",
      isPreview: true
    });
  }

  triggerPreviewNotifications() {
    const PREVIEW_BODIES = [
      "**@SpikeHD** joined **#Gaming General** — ready to play!",
      "@Bluscream: hey what's the plan for tonight? thinking **Among Us** or maybe some _Valorant_?",
      "@Minopia started streaming — click to watch the live stream ~~now~~ right away!",
      "**@OverwolfBot** enabled their camera 📷",
      "@SpikeHD: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt.",
      "@Minopia left **#Gaming General** — see you next time!",
      "**@Bluscream** started typing...",
      "@OverwolfBot: `!rank` — **Diamond I** • 847 LP • 63% winrate this season",
    ];
    const PREVIEW_ICONS = [
      "https://cdn.discordapp.com/embed/avatars/0.png",
      "https://cdn.discordapp.com/embed/avatars/1.png",
      "https://cdn.discordapp.com/embed/avatars/2.png",
      "https://cdn.discordapp.com/embed/avatars/3.png",
    ];
    const count = window.appSettings.maxNotifications || 5;
    this.eventBus.trigger('fill-preview-notifications', { count, bodies: PREVIEW_BODIES, icons: PREVIEW_ICONS });
  }

  clearPreviewNotifications() {
    this.eventBus.trigger('clear-preview-notifications');
  }

  clearVoiceState() {
    window.rpcState.channelId = null;
    window.rpcState.guildId = null;
    window.rpcState.channelName = '';
    window.rpcState.guildName = '';
    window.rpcState.users = [];
  }

  mapVoiceState(vs) {
    const userId = vs.user.id;
    return {
      id: userId,
      username: vs.nick || vs.user.global_name || vs.user.username,
      avatarUrl: vs.user.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${vs.user.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/${parseInt(userId, 10) % 5}.png`,
      mute: vs.voice_state.mute || vs.voice_state.self_mute,
      deaf: vs.voice_state.deaf || vs.voice_state.self_deaf,
      video: vs.voice_state.self_video || false,
      streaming: vs.voice_state.self_stream || false,
      watching: false,
      speaking: false
    };
  }

  setSpeaking(userId, speaking) {
    const user = window.rpcState.users.find(u => u.id === userId);
    if (user && user.speaking !== speaking) {
      user.speaking = speaking;
      this.eventBus.trigger('state-updated', window.rpcState);
    }
  }

  send(cmd, args = {}, evt = null, extra = null) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const nonce = String(Math.random());
    const payload = { cmd, nonce };
    if (Object.keys(args).length > 0 || cmd === 'SELECT_VOICE_CHANNEL') {
      payload.args = args;
    }
    if (evt) {
      payload.evt = evt;
    }
    if (extra) {
      payload.args = Object.assign(payload.args || {}, extra);
    }
    this.ws.send(JSON.stringify(payload));
  }

  // --- EQUICORD WEBSOCKET BRIDGE SERVER (ws://127.0.0.1:6888) ---
  startBridgeServer() {
    if (!this.bridgePlugin) {
      console.warn("C# WebSocket Server Plugin not loaded yet.");
      this.eventBus.trigger('connection-status', 'disconnected');
      return;
    }
    this.eventBus.trigger('connection-status', 'connecting');
    this.bridgePlugin.Start(6888, (result) => {
      if (result && result.success) {
        console.log("C# WebSocket Server started successfully on port 6888.");
        window.rpcState.connected = true;
        this.eventBus.trigger('connection-status', 'connected');
      } else {
        console.error("C# WebSocket Server failed to start:", result.error);
        this.eventBus.trigger('connection-status', 'error');
      }
    });
  }

  stopBridgeServer() {
    if (this.bridgePlugin) {
      this.bridgePlugin.Stop((result) => {
        console.log("C# WebSocket Server stopped:", result);
      });
    }
    window.rpcState.connected = false;
    window.rpcState.authenticated = false;
    this.clearVoiceState();
    this.eventBus.trigger('state-updated', window.rpcState);
    this.channelReady = false;
    this.pendingNotifications = [];
  }

  handleBridgeStatus(status) {
    console.log("C# WS Server Status:", status);

    // Handle client disconnect/error - clear voice state since we won't get CHANNEL_LEFT
    if (status && (status.includes('disconnected') || status.includes('error'))) {
      console.log("Client disconnected/error detected, clearing voice state");
      this.clearVoiceState();
      this.eventBus.trigger('state-updated', window.rpcState);
      window.rpcState.connected = false;
      window.rpcState.authenticated = false;
      this.eventBus.trigger('connection-status', 'disconnected');
      this.channelReady = false;
      this.pendingNotifications = [];
    }
  }

  handleBridgeMessage(messageStr) {
    try {
      const payload = JSON.parse(messageStr);
      console.log("Bridge message received:", payload.cmd, JSON.stringify(payload));

      switch (payload.cmd) {
        case "REGISTER_CONFIG":
          this.bridgeUserId = payload.userId;
          window.rpcState.connected = true;
          window.rpcState.authenticated = true;
          this.eventBus.trigger('connection-status', 'authenticated');
          break;
        case "CHANNEL_JOINED":
          window.rpcState.connected = true;
          window.rpcState.authenticated = true;
          this.eventBus.trigger('connection-status', 'authenticated');

          if (payload.states && payload.states.length > 0) {
            // channelId comes from the payload top-level or the first state's channelId
            window.rpcState.channelId   = payload.channelId   || payload.states[0].channelId || null;
            window.rpcState.guildId     = payload.guildId     || "";
            window.rpcState.channelName = payload.channelName || "";
            window.rpcState.guildName   = payload.guildName   || "";
            window.rpcState.users = payload.states.map(s => this.mapBridgeVoiceState(s));

            const me = window.rpcState.users.find(u => u.id === this.bridgeUserId);
            if (me) {
              window.rpcState.selfMute      = me.mute;
              window.rpcState.selfDeaf      = me.deaf;
              window.rpcState.selfStreaming  = me.streaming;
              window.rpcState.selfVideo      = me.video;
            }
          }
          // Soundboard: bridge protocol doesn't carry it — clear any stale RPC sounds
          window.rpcState.soundboardSounds = payload.soundboardSounds || [];
          this.eventBus.trigger('state-updated', window.rpcState);
          // Channel state is now populated — flush any notifications that arrived
          // before this message (bridge sends queued messages before CHANNEL_JOINED)
          this.flushPendingNotifications();
          break;
        case "VOICE_STATE_UPDATE":
          if (payload.state) {
            const userState = payload.state;

            // Mirror Orbolay's removal logic exactly:
            // remove if channelId is JSON null, or if it's a different channel than the current one.
            // An absent/undefined channelId means the field wasn't sent — treat as same-channel update.
            const channelIdPresent = 'channelId' in userState;
            const channelIdNull = channelIdPresent && userState.channelId === null;
            const movedChannel = channelIdPresent && userState.channelId !== null && userState.channelId !== window.rpcState.channelId;
            const shouldRemove = channelIdNull || movedChannel;

            if (shouldRemove) {
              const leavingUser = window.rpcState.users.find(u => u.id === userState.userId);
              if (leavingUser) {
                this.checkUserEventNotifications(leavingUser, null);
              }
              window.rpcState.users = window.rpcState.users.filter(u => u.id !== userState.userId);
            } else {
              let user = window.rpcState.users.find(u => u.id === userState.userId);
              const mapped = this.mapBridgeVoiceState(userState);

              if (user) {
                // Preserve fields not included in this partial update
                if (mapped.username === null)   mapped.username   = user.username;
                if (mapped.avatarUrl === null)  mapped.avatarUrl  = user.avatarUrl;
                if (userState.streaming == null) mapped.streaming = user.streaming;
                if (userState.speaking  == null) {
                  mapped.speaking = (mapped.mute || mapped.deaf) ? false : user.speaking;
                }
                const prevUser = Object.assign({}, user);
                Object.assign(user, mapped);
                this.checkUserEventNotifications(prevUser, user);
              } else {
                window.rpcState.users.push(mapped);
                this.checkUserEventNotifications(null, mapped);
              }

              if (userState.userId === this.bridgeUserId) {
                window.rpcState.selfMute      = mapped.mute;
                window.rpcState.selfDeaf      = mapped.deaf;
                window.rpcState.selfStreaming  = mapped.streaming;
                window.rpcState.selfVideo      = mapped.video;
              }
            }
            this.eventBus.trigger('state-updated', window.rpcState);
          }
          break;
        case "CHANNEL_LEFT":
          this.clearVoiceState();
          this.eventBus.trigger('state-updated', window.rpcState);
          break;
        case "MESSAGE_NOTIFICATION":
          if (window.appSettings.notificationsEnabled && payload.message) {
            this.emitNotification({
              title: payload.message.title || "Notification",
              body: payload.message.body || "",
              icon: payload.message.icon || ""
            });
          }
          break;
        case "STREAMER_MODE":
          // Censor / Streamer mode if needed
          break;
        case "TYPING_START": {
          const { userId } = payload;
          const user = window.rpcState.users.find(u => u.id === userId);
          if (!user) break;

          // Clear any existing expiry timer for this user
          if (this.typingTimers[userId]) {
            clearTimeout(this.typingTimers[userId]);
          }

          const prev = { ...user };
          user.typing = true;
          this.checkUserEventNotifications(prev, user);
          this.eventBus.trigger('state-updated', window.rpcState);

          // Auto-expire after 10s (mirrors Discord's own typing timeout)
          this.typingTimers[userId] = setTimeout(() => {
            const prevExp = { ...user };
            user.typing = false;
            delete this.typingTimers[userId];
            this.checkUserEventNotifications(prevExp, user);
            this.eventBus.trigger('state-updated', window.rpcState);
          }, 10000);
          break;
        }
        case "SPEAKING_UPDATE":
          this.setSpeaking(payload.userId, payload.speaking);
          break;
      }
    } catch(e) {
      console.error("Failed to parse bridge message:", e);
    }
  }

  mapBridgeVoiceState(s) {
    // avatarUrl from the bridge is a bare hash, not a full URL
    const avatarUrl = s.avatarUrl
      ? `https://cdn.discordapp.com/avatars/${s.userId}/${s.avatarUrl}.png`
      : null; // null = "not provided in this update", caller preserves existing
    return {
      id: s.userId,
      username: s.username || null,   // null = not provided, caller preserves existing
      avatarUrl,
      mute:      s.mute      ?? false,
      deaf:      s.deaf      ?? false,
      video:     s.video     ?? false,
      streaming: s.streaming ?? false,
      watching:  s.watching  ?? false,
      speaking:  s.speaking  ?? false,
      typing: false
    };
  }

  sendBridgeMessage(payload) {
    if (this.bridgePlugin) {
      this.bridgePlugin.Send(JSON.stringify(payload), (res) => {
        if (res && !res.success) {
          console.error("C# Bridge Plugin failed to send:", res.error);
        }
      });
    }
  }

  // --- ACTIONS CONTROLLERS ---
  toggleMute() {
    const mode = window.appSettings.connectionMode;
    if (mode === 'mock') {
      window.rpcState.selfMute = !window.rpcState.selfMute;
      this.eventBus.trigger('state-updated', window.rpcState);
      return;
    }
    if (mode === 'bridge') {
      this.sendBridgeMessage({ cmd: "TOGGLE_MUTE" });
      return;
    }
    this.send('SET_VOICE_SETTINGS', { mute: !window.rpcState.selfMute });
  }

  toggleDeafen() {
    const mode = window.appSettings.connectionMode;
    if (mode === 'mock') {
      window.rpcState.selfDeaf = !window.rpcState.selfDeaf;
      if (window.rpcState.selfDeaf) window.rpcState.selfMute = true;
      this.eventBus.trigger('state-updated', window.rpcState);
      return;
    }
    if (mode === 'bridge') {
      this.sendBridgeMessage({ cmd: "TOGGLE_DEAF" });
      return;
    }
    this.send('SET_VOICE_SETTINGS', { deaf: !window.rpcState.selfDeaf });
  }

  disconnectVoice() {
    const mode = window.appSettings.connectionMode;
    if (mode === 'mock') {
      this.clearVoiceState();
      this.eventBus.trigger('state-updated', window.rpcState);
      return;
    }
    if (mode === 'bridge') {
      this.sendBridgeMessage({ cmd: "DISCONNECT" });
      return;
    }
    this.send('SELECT_VOICE_CHANNEL', { channel_id: null });
  }

  async openSettings() {
    const state = await WindowsService.getWindowState('settings').catch(() => 'closed');
    if (state === 'normal' || state === 'maximized') {
      await WindowsService.close('settings');
    } else {
      await WindowsService.restore('settings');
    }
  }

  startStream(source) {
    const mode = window.appSettings.connectionMode;
    if (mode === 'mock') {
      window.rpcState.selfStreaming = true;
      const me = window.rpcState.users.find(u => u.id === '101');
      if (me) me.streaming = true;
      this.eventBus.trigger('state-updated', window.rpcState);
      return;
    }
    if (mode === 'bridge') {
      this.sendBridgeMessage({ cmd: "START_STREAM", source });
      return;
    }
    console.warn("Stream start not supported in RPC mode.");
  }

  stopStream() {
    const mode = window.appSettings.connectionMode;
    if (mode === 'mock') {
      window.rpcState.selfStreaming = false;
      this.eventBus.trigger('state-updated', window.rpcState);
      return;
    }
    if (mode === 'bridge') {
      this.sendBridgeMessage({ cmd: "STOP_STREAM" });
      return;
    }
    console.warn("Stream stop not supported in RPC mode.");
  }

  toggleCamera() {
    const mode = window.appSettings.connectionMode;
    if (mode === 'mock') {
      window.rpcState.selfVideo = !window.rpcState.selfVideo;
      this.eventBus.trigger('state-updated', window.rpcState);
      return;
    }
    if (mode === 'bridge') {
      this.sendBridgeMessage({ cmd: "TOGGLE_CAMERA" });
      return;
    }
    console.warn("Camera toggle not supported in RPC mode.");
  }

  playSound(soundId, guildId) {
    const mode = window.appSettings.connectionMode;
    console.log(`playSound called: soundId=${soundId} guildId=${guildId} mode=${mode}`);
    if (mode === 'mock') {
      console.log(`Mock Sound Played: ${soundId}`);
      return;
    }
    if (mode === 'bridge') {
      this.sendBridgeMessage({ cmd: "PLAY_SOUNDBOARD_SOUND", soundId, guildId });
      return;
    }
    this.send('PLAY_SOUNDBOARD_SOUND', { sound_id: soundId, guild_id: guildId });
  }

  // --- MOCK SIMULATION ---
  startMockSimulation() {
    this.stopMockSimulation();
    console.log("Mock Mode Simulation Started");

    window.rpcState.connected = true;
    window.rpcState.authenticated = true;
    window.rpcState.channelName = "Gaming General";
    window.rpcState.guildName = "Antigravity Dev Lab";
    window.rpcState.selfMute = false;
    window.rpcState.selfDeaf = false;
    
    window.rpcState.soundboardSounds = [
      { soundId: "s1", name: "Airhorn", volume: 1.0, guildId: "g1", emojiName: "🚨" },
      { soundId: "s2", name: "Sad Trombone", volume: 1.0, guildId: "g1", emojiName: "🎺" },
      { soundId: "s3", name: "Ba-Dum-Tss", volume: 1.0, guildId: "g1", emojiName: "🥁" },
      { soundId: "s4", name: "Bruh Moment", volume: 1.0, guildId: "g1", emojiName: "🗿" },
      { soundId: "s5", name: "Victory Fanfare", volume: 0.8, guildId: "g1", emojiName: "🎉" },
      { soundId: "s6", name: "Quack", volume: 1.0, guildId: "g1", emojiName: "🦆" }
    ];

    window.rpcState.users = [
      { id: "100", username: "SpikeHD", avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png", mute: false, deaf: false, video: true, streaming: false, watching: false, speaking: false },
      { id: "101", username: "Bluscream", avatarUrl: "https://cdn.discordapp.com/embed/avatars/1.png", mute: true, deaf: false, video: false, streaming: true, watching: false, speaking: false },
      { id: "102", username: "Minopia", avatarUrl: "https://cdn.discordapp.com/embed/avatars/2.png", mute: false, deaf: true, video: false, streaming: false, watching: true, speaking: false },
      { id: "103", username: "OverwolfBot", avatarUrl: "https://cdn.discordapp.com/embed/avatars/3.png", mute: false, deaf: false, video: false, streaming: false, watching: false, speaking: false }
    ];

    this.eventBus.trigger('connection-status', 'authenticated');
    this.eventBus.trigger('state-updated', window.rpcState);

    let cycle = 0;
    this.mockInterval = setInterval(() => {
      cycle++;
      window.rpcState.users.forEach((user, idx) => {
        if (user.mute || user.deaf) {
          user.speaking = false;
          return;
        }
        user.speaking = (Math.sin(cycle + idx) > 0.4);
      });

      // Simulating user events
      if (cycle === 4) {
        const user = window.rpcState.users.find(u => u.id === "100");
        if (user) {
          const prev = { ...user };
          user.streaming = true;
          this.checkUserEventNotifications(prev, user);
        }
      } else if (cycle === 8) {
        const user = window.rpcState.users.find(u => u.id === "100");
        if (user) {
          const prev = { ...user };
          user.streaming = false;
          this.checkUserEventNotifications(prev, user);
        }
      } else if (cycle === 12) {
        const user = window.rpcState.users.find(u => u.id === "103");
        if (user) {
          this.checkUserEventNotifications(user, null);
          window.rpcState.users = window.rpcState.users.filter(u => u.id !== "103");
        }
      } else if (cycle === 16) {
        const newUser = { id: "103", username: "OverwolfBot", avatarUrl: "https://cdn.discordapp.com/embed/avatars/3.png", mute: false, deaf: false, video: false, streaming: false, watching: false, speaking: false };
        this.checkUserEventNotifications(null, newUser);
        window.rpcState.users.push(newUser);
      } else if (cycle === 20) {
        const user = window.rpcState.users.find(u => u.id === "103");
        if (user) {
          const prev = { ...user };
          user.video = true;
          this.checkUserEventNotifications(prev, user);
        }
      } else if (cycle === 24) {
        const user = window.rpcState.users.find(u => u.id === "103");
        if (user) {
          const prev = { ...user };
          user.video = false;
          this.checkUserEventNotifications(prev, user);
        }
      } else if (cycle === 26) {
        const user = window.rpcState.users.find(u => u.id === "100");
        if (user) {
          const prev = { ...user };
          user.typing = true;
          this.checkUserEventNotifications(prev, user);
        }
      } else if (cycle === 30) {
        const user = window.rpcState.users.find(u => u.id === "100");
        if (user) {
          const prev = { ...user };
          user.typing = false;
          this.checkUserEventNotifications(prev, user);
        }
      }

      if (cycle % 12 === 0 && window.appSettings.notificationsEnabled) {
        this.sendNotification({
          title: "New Message",
          body: `Bluscream: What's the plan for tonight?`,
          icon: "https://cdn.discordapp.com/embed/avatars/1.png"
        });
      }

      this.eventBus.trigger('state-updated', window.rpcState);
    }, 1500);
  }

  stopMockSimulation() {
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
  }

  initCentralSettings() {
    const appName = "Discord Overlay";
    const schema = [
      {
        key: "alignment",
        label: "Overlay Alignment Corner",
        description: "Default corner for HUD positioning.",
        type: "select",
        category: "Position",
        options: [
          { value: "topLeft", label: "Top Left" },
          { value: "topRight", label: "Top Right" },
          { value: "bottomLeft", label: "Bottom Left" },
          { value: "bottomRight", label: "Bottom Right" }
        ],
        default: "topLeft"
      },
      {
        key: "horizontalOffset",
        label: "Horizontal Offset",
        description: "Margin from the left/right screen edges.",
        type: "slider",
        category: "Position",
        min: 0,
        max: 500,
        step: 5,
        unit: "px",
        default: 20
      },
      {
        key: "verticalOffset",
        label: "Vertical Offset",
        description: "Margin from the top/bottom screen edges.",
        type: "slider",
        category: "Position",
        min: 0,
        max: 500,
        step: 5,
        unit: "px",
        default: 20
      },
      {
        key: "notificationsEnabled",
        label: "Enable Voice Alerts",
        description: "Show notifications for mute, deafen, and stream actions.",
        type: "checkbox",
        category: "Alerts",
        default: true
      },
      {
        key: "eventNotificationsEnabled",
        label: "Enable Channel Event Alerts",
        description: "Show notifications when users join or leave the voice channel.",
        type: "checkbox",
        category: "Alerts",
        default: true
      },
      {
        key: "useExternalNotifications",
        label: "Use Shared Notifications App",
        description: "Route all overlay toasts to the shared Notifications service instead of local overlays.",
        type: "checkbox",
        category: "Alerts",
        default: true
      },
      {
        key: "externalNotificationsPort",
        label: "Notifications Service Port",
        description: "Port where the shared Notifications server is listening.",
        type: "number",
        category: "Alerts",
        default: 61234
      },
      {
        key: "notificationScale",
        label: "Alert Scale",
        description: "Adjust sizing multiplier of the notification toasts.",
        type: "slider",
        category: "Appearance",
        min: 50,
        max: 200,
        step: 10,
        unit: "%",
        default: 100
      },
      {
        key: "notificationOpacity",
        label: "Alert Opacity",
        description: "Adjust transparency of notification toasts.",
        type: "slider",
        category: "Appearance",
        min: 10,
        max: 100,
        step: 5,
        unit: "%",
        default: 100
      },
      {
        key: "maxNotifications",
        label: "Max Stacked Alerts",
        description: "Maximum alerts visible simultaneously before evicting.",
        type: "number",
        category: "Appearance",
        default: 5
      },
      {
        key: "markdownEnabled",
        label: "Enable Markdown in Chat",
        description: "Parse bold, italics, code, and spoiler syntax in messages.",
        type: "checkbox",
        category: "Chat",
        default: true
      },
      {
        key: "autoLaunch",
        label: "Start with Overwolf",
        description: "Automatically start this app when the Overwolf client starts.",
        type: "checkbox",
        category: "Lifecycle",
        default: true
      },
      {
        key: "closeOnGameExit",
        label: "Close on Game Exit",
        description: "Shut down this app automatically when all games are closed.",
        type: "checkbox",
        category: "Lifecycle",
        default: false
      },
      {
        key: "overlayOnDesktop",
        label: "Show Overlay on Desktop",
        description: "Maintain HUD visible when out of game.",
        type: "checkbox",
        category: "General",
        default: true
      },
      {
        key: "connectionMode",
        label: "Connection Mode",
        description: "Choose interface layer (RPC, bridge server, or mock testing).",
        type: "select",
        category: "General",
        options: [
          { value: "rpc", label: "Discord RPC" },
          { value: "bridge", label: "C# Bridge Server" },
          { value: "mock", label: "Mock Mode (Testing)" }
        ],
        default: "rpc"
      },
      {
        key: "statusOverlayVisible",
        label: "Status Indicator HUD",
        description: "Show connection status pill on screen.",
        type: "checkbox",
        category: "General",
        default: true
      },
      {
        key: "dashboardOverlayVisible",
        label: "Control Dashboard HUD",
        description: "Show audio/stream control widget.",
        type: "checkbox",
        category: "General",
        default: true
      }
    ];

    const regData = {
      app: appName,
      icon: "https://cdn.simpleicons.org/discord",
      settings: schema
    };

    const register = () => {
      fetch('http://localhost:61235/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regData)
      }).then(res => {
        if (!res.ok) throw new Error();
        console.log(`[discord-overlay] Registered schema successfully.`);
      }).catch(() => {
        setTimeout(register, 3000);
      });
    };
    register();

    overwolf.extensions.getExtensions((r) => {
      if (!r || !r.extensions) return;
      const sm = r.extensions.find(e => e.meta && e.meta.name === 'Settings Manager');
      if (!sm) return;

      const applyData = (infoStr) => {
        try {
          const apps = JSON.parse(infoStr);
          if (apps && apps[appName] && apps[appName].values) {
            const vals = apps[appName].values;
            const updated = {};
            
            if (vals.alignment !== undefined) updated.alignment = vals.alignment;
            if (vals.horizontalOffset !== undefined) updated.horizontalOffset = parseInt(vals.horizontalOffset, 10);
            if (vals.verticalOffset !== undefined) updated.verticalOffset = parseInt(vals.verticalOffset, 10);
            if (vals.notificationsEnabled !== undefined) updated.notificationsEnabled = vals.notificationsEnabled !== false;
            if (vals.eventNotificationsEnabled !== undefined) updated.eventNotificationsEnabled = vals.eventNotificationsEnabled !== false;
            if (vals.useExternalNotifications !== undefined) updated.useExternalNotifications = vals.useExternalNotifications !== false;
            if (vals.externalNotificationsPort !== undefined) updated.externalNotificationsPort = parseInt(vals.externalNotificationsPort, 10);
            
            if (vals.notificationScale !== undefined) {
              updated.notificationScale = parseFloat(vals.notificationScale) / 100;
            }
            if (vals.notificationOpacity !== undefined) {
              updated.notificationOpacity = parseFloat(vals.notificationOpacity) / 100;
            }
            if (vals.maxNotifications !== undefined) updated.maxNotifications = parseInt(vals.maxNotifications, 10);
            if (vals.markdownEnabled !== undefined) updated.markdownEnabled = vals.markdownEnabled !== false;
            if (vals.overlayOnDesktop !== undefined) updated.overlayOnDesktop = vals.overlayOnDesktop !== false;
            if (vals.connectionMode !== undefined) updated.connectionMode = vals.connectionMode;
            if (vals.statusOverlayVisible !== undefined) updated.statusOverlayVisible = vals.statusOverlayVisible !== false;
            if (vals.dashboardOverlayVisible !== undefined) updated.dashboardOverlayVisible = vals.dashboardOverlayVisible !== false;
            if (vals.autoLaunch !== undefined) updated.autoLaunch = vals.autoLaunch !== false;
            if (vals.closeOnGameExit !== undefined) updated.closeOnGameExit = vals.closeOnGameExit === true;

            Object.assign(window.appSettings, updated);
            for (const [key, val] of Object.entries(updated)) {
              localStorage.setItem(key, String(val));
            }
            this.eventBus.trigger('settings-changed', window.appSettings);
            if ('overlayOnDesktop' in updated) {
              this.checkGameStatus();
            }
            this.positionOverlayWindows();
          }
        } catch (err) {
          console.error('[discord-overlay] failed to parse settings:', err);
        }
      };

      overwolf.extensions.getInfo(sm.id, (infoRes) => {
        if (infoRes && infoRes.status === 'success' && infoRes.info) {
          applyData(infoRes.info);
        }
      });

      overwolf.extensions.registerInfo(sm.id, (infoUpdate) => {
        if (infoUpdate) applyData(infoUpdate);
      });
    });
  }
}

// Instantiate and run controller
const controller = new BackgroundController();
window.controller = controller;
controller.run();
