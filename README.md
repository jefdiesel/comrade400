# Comrade400

A Discord bot that detects small PNG, GIF, and WebP images, upscales them using nearest-neighbor interpolation, and reposts a crisp, pixel-perfect PNG. No blur, no smoothing — just clean, sharp pixels.

## What it does

When someone posts a small image (128x128 or under), the bot automatically replies with an upscaled version at 400x400. The reply includes size buttons to swap between **400x400**, **512x512**, and **640x640**.

Supports PNG, GIF, and WebP input. Always outputs PNG.

## Why nearest-neighbor?

Standard resizing algorithms (bilinear, bicubic) blend neighboring pixels together, turning crisp pixel art into a blurry mess. Nearest-neighbor just makes each pixel bigger — no interpolation, no artifacts.

## Saving images on iPhone

iOS Safari converts images to JPEG when you long-press and save directly. JPEG is lossy and will ruin pixel art. To get the actual file:

1. **Long press** the image
2. **Open in New Tab**
3. **Save to phone** — this preserves the original PNG/WebP format

If you already saved a JPEG, the damage is done — upscaling a JPEG will just make the compression artifacts bigger. Always save the original format first.

## Setup

### 1. Create a Discord bot

- Go to the [Discord Developer Portal](https://discord.com/developers/applications)
- Create a new application
- Under **Bot**, enable **Message Content Intent**
- Copy the bot token

### 2. Invite to a server

Use this link (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=117760&scope=bot
```

The bot needs **Send Messages**, **Attach Files**, and **Read Message History** permissions.

### 3. Run

```bash
npm install
DISCORD_TOKEN=your-token-here node index.js
```

### 4. Deploy (optional)

The bot runs on [Railway](https://railway.app). To deploy your own:

```bash
railway init
railway up
railway variables set DISCORD_TOKEN=your-token-here
```

## Config

Edit these values at the top of `index.js`:

| Variable | Default | Description |
|---|---|---|
| `MAX_SOURCE_SIZE` | `128` | Only upscale images this size or smaller (px) |
| `DEFAULT_SIZE` | `400` | Initial upscale size |
| `SIZE_OPTIONS` | `[400, 512, 640]` | Sizes available via buttons |
