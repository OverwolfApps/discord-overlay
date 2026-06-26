# Discord Overlay

An overlay app for Discord that runs on the Overwolf platform. Powered by OrbolayBridge.

## Features

- **In-game Discord Overlay**: Display Discord voice channel information while gaming
- **Voice Activity Indicators**: See who's talking in your voice channel
- **Join/Leave Notifications**: Get notified when users join or leave your voice channel
- **Interactive Mode**: Toggle overlay interaction with customizable hotkey (default: Ctrl+BackQuote)
- **Transparent Windows**: Seamless integration with your game
- **Settings Window**: Configure the overlay to your preferences

## Requirements

- Overwolf Client (minimum version 0.170.0)
- Windows operating system

## Installation

### Manual Installation (.opk)

1. Download the latest `.opk` file from the [GitHub Releases](https://github.com/OverwolfApps/discord-overlay/releases)
2. Open the Overwolf client
3. Go to Settings → Apps → "Install App from .opk file"
4. Select the downloaded `.opk` file
5. The app will be installed and appear in your Overwolf library

## Usage

1. Open Discord and join a voice channel
2. Launch a game
3. The overlay will automatically appear when you're in-game
4. Use `Ctrl+BackQuote` (or your custom hotkey) to toggle interactive mode
5. Access settings by right-clicking the app icon in the Overwolf dock

## Hotkeys

| Hotkey | Action |
|--------|--------|
| Ctrl+BackQuote | Toggle Overlay Interaction (Unlock Cursor) |

## Development

This app uses:
- Overwolf API for window management and hotkeys
- WebSocket plugin for communication
- HTML/CSS/JavaScript for the UI

## Authors

- Bluscream
- Antigravity

## License

This project is unlicensed and released into the public domain.

## Support

For issues and feature requests, please visit the project repository or contact the authors through Overwolf.
