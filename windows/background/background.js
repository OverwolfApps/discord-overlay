import { EventBus } from '../../scripts/event-bus.js';
import { WindowsService } from '../../scripts/windows-service.js';

const CLIENT_ID = '207646673902501888'; // Streamkit Client ID

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
      soundboardSounds: []
    };

    // Global application settings (loaded from localStorage or defaults)
    window.appSettings = {
      alignment: localStorage.getItem('alignment') || 'topLeft',
      horizontalOffset: parseInt(localStorage.getItem('horizontalOffset') || '20', 10),
      verticalOffset: parseInt(localStorage.getItem('verticalOffset') || '20', 10),
      notificationsEnabled: localStorage.getItem('notificationsEnabled') !== 'false',
      eventNotificationsEnabled: localStorage.getItem('eventNotificationsEnabled') !== 'false',
      notificationScale: parseFloat(localStorage.getItem('notificationScale') || '1.0'),
      notificationOpacity: parseFloat(localStorage.getItem('notificationOpacity') ?? '1.0'),
      maxNotifications: parseInt(localStorage.getItem('maxNotifications') || '5', 10),
      markdownEnabled: localStorage.getItem('markdownEnabled') !== 'false',
      overlayOnDesktop: localStorage.getItem('overlayOnDesktop') === 'true',
      connectionMode: localStorage.getItem('connectionMode') || 'rpc' // 'rpc', 'bridge', 'mock'
    };

    this.ws = null;
    this.token = localStorage.getItem('discord_token') || null;
    this.reconnectTimeout = null;
    this.mockInterval = null;
    this.overlayInteractive = false;
    this.typingTimers = {}; // userId → setTimeout handle for typing expiry

    // C# WebSocket Server Plugin
    this.bridgePlugin = null;
    this.bridgeUserId = null;
  }

  async run() {
    // 1. Load initial settings
    this.eventBus.trigger('settings-changed', window.appSettings);

    // 2. Initialize Overwolf window controllers & launch settings page on start
    await WindowsService.restore('settings');
    await WindowsService.restore('notifications');
    await WindowsService.setClickThrough('notifications', true);
    await WindowsService.setTopmost('notifications', true);
    
    // Check if game is already running or launches later
    this.checkGameStatus();
    overwolf.games.onGameInfoUpdated.addListener(() => this.checkGameStatus());

    // Register hotkeys
    this.registerHotkeys();

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
  }

  initBridgePlugin() {
    try {
      overwolf.extensions.current.getExtraObject("websocket-server-plugin", (result) => {
        if (result.status === "success") {
          this.bridgePlugin = result.object;
          this.bridgePlugin.OnMessage.addListener((msg) => this.handleBridgeMessage(msg));
          this.bridgePlugin.OnStatus.addListener((status) => console.log("C# WS Server Status:", status));
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

  registerHotkeys() {
    overwolf.settings.hotkeys.onPressed.addListener(async (info) => {
      if (info.name === 'toggle_overlay_interactive') {
        this.overlayInteractive = !this.overlayInteractive;
        try {
          await WindowsService.setClickThrough('overlay', !this.overlayInteractive);
          this.eventBus.trigger('overlay-interactive-changed', this.overlayInteractive);
          console.log("Overlay interaction toggled:", this.overlayInteractive);
        } catch (e) {
          console.warn("Failed to set overlay clickthrough:", e);
        }
      }
    });
  }

  async checkGameStatus() {
    overwolf.games.getRunningGameInfo(async (gameInfo) => {
      const isGameRunning = gameInfo && gameInfo.isRunning;
      const showOnDesktop = window.appSettings.overlayOnDesktop;
      const overlayState = await WindowsService.getWindowState('overlay');

      if (isGameRunning || showOnDesktop) {
        if (overlayState === 'closed' || overlayState === 'hidden') {
          await WindowsService.restore('overlay');
          await WindowsService.setClickThrough('overlay', !this.overlayInteractive);
          await WindowsService.setTopmost('overlay', true);
        }
      } else {
        if (overlayState !== 'closed') {
          await WindowsService.close('overlay');
        }
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
  }

  changeConnectionMode(mode) {
    this.saveSettings({ connectionMode: mode });
    this.startActiveMode();
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
          this.eventBus.trigger('notification', {
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
    this.eventBus.trigger('notification', {
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
  }

  handleBridgeMessage(messageStr) {
    try {
      const payload = JSON.parse(messageStr);

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
            window.rpcState.channelId   = payload.channelId || payload.states[0].channelId || "0";
            window.rpcState.guildId     = payload.guildId   || "";
            window.rpcState.channelName = payload.channelName || "Voice Channel";
            window.rpcState.guildName   = payload.guildName   || "Server";
            window.rpcState.users = payload.states.map(s => this.mapBridgeVoiceState(s));

            const me = window.rpcState.users.find(u => u.id === this.bridgeUserId);
            if (me) {
              window.rpcState.selfMute = me.mute;
              window.rpcState.selfDeaf = me.deaf;
            }
          }
          this.eventBus.trigger('state-updated', window.rpcState);
          break;
        case "VOICE_STATE_UPDATE":
          if (payload.state) {
            const userState = payload.state;
            
            // Check left
            if (!userState.channelId || userState.channelId === "0") {
              const leavingUser = window.rpcState.users.find(u => u.id === userState.userId);
              if (leavingUser) {
                this.checkUserEventNotifications(leavingUser, null);
              }
              window.rpcState.users = window.rpcState.users.filter(u => u.id !== userState.userId);
            } else {
              window.rpcState.channelId = userState.channelId;
              let user = window.rpcState.users.find(u => u.id === userState.userId);
              const mapped = this.mapBridgeVoiceState(userState);
              if (user) {
                const prevUser = Object.assign({}, user);
                Object.assign(user, mapped);
                this.checkUserEventNotifications(prevUser, user);
              } else {
                window.rpcState.users.push(mapped);
                this.checkUserEventNotifications(null, mapped);
              }

              if (userState.userId === this.bridgeUserId) {
                window.rpcState.selfMute = mapped.mute;
                window.rpcState.selfDeaf = mapped.deaf;
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
            this.eventBus.trigger('notification', {
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
      }
    } catch(e) {
      console.error("Failed to parse bridge message:", e);
    }
  }

  mapBridgeVoiceState(s) {
    return {
      id: s.userId,
      username: s.username || "Unknown",
      avatarUrl: s.avatarUrl ? `https://cdn.discordapp.com/avatars/${s.userId}/${s.avatarUrl}.png` : `https://cdn.discordapp.com/embed/avatars/${parseInt(s.userId, 10) % 5}.png`,
      mute: s.mute || false,
      deaf: s.deaf || false,
      video: s.video || false,
      streaming: s.streaming || false,
      watching: s.watching || false,
      speaking: s.speaking || false,
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

  playSound(soundId, guildId) {
    const mode = window.appSettings.connectionMode;
    if (mode === 'mock') {
      console.log(`Mock Sound Played: ${soundId}`);
      return;
    }
    if (mode === 'bridge') {
      // Mod plugin does not handle playing soundboard sounds inside incoming commands
      console.warn("Soundboard plays not supported in Equicord Bridge mode.");
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
        this.eventBus.trigger('notification', {
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
}

// Instantiate and run controller
const controller = new BackgroundController();
window.controller = controller;
controller.run();
