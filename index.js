const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("Set DISCORD_TOKEN environment variable");
  process.exit(1);
}

const DEFAULT_SIZE = 400;
const MAX_SOURCE_SIZE = 128;
const SIZE_OPTIONS = [400, 512, 640];
const MAX_CACHE_ENTRIES = 100;

const ANIM_FRAMES = 128;
const ANIM_FRAME_DELAY = 90;
const ANIM_SIZE = 64;
const MEME_MAX_CHARS = 20;

// Wallet verification
const VERIFY_SITE = "https://chainhost.online";
const VERIFY_API = `${VERIFY_SITE}/api/verify`;
const VERIFY_ROLES = [
  { name: "Call Data Comrades", role: "CDC Holder" },
  { name: "Comrades of the Dead", role: "COTD Holder" },
];
const verifyNonces = new Map();
const NONCE_TTL = 10 * 60 * 1000; // 10 minutes

function generateNonce() {
  return [...Array(16)]
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join("");
}

async function ensureRoles(guild) {
  const roles = {};
  for (const v of VERIFY_ROLES) {
    let role = guild.roles.cache.find((r) => r.name === v.role);
    if (!role) {
      role = await guild.roles.create({
        name: v.role,
        reason: "Comrade400 wallet verification",
      });
    }
    roles[v.name] = role;
  }
  return roles;
}

// Register fonts with fontconfig so librsvg can find them
const fontDir = path.join(__dirname, "fonts");
if (!fs.existsSync(fontDir)) fs.mkdirSync(fontDir);
const fontDest = path.join(fontDir, "Pizzascript-Sneps.otf");
if (!fs.existsSync(fontDest)) fs.copyFileSync(path.join(__dirname, "Pizzascript-Sneps.otf"), fontDest);
const impactDest = path.join(fontDir, "Impact.ttf");
if (!fs.existsSync(impactDest)) fs.copyFileSync(path.join(__dirname, "Impact.ttf"), impactDest);
// Point fontconfig to our fonts directory
process.env.FONTCONFIG_PATH = process.env.FONTCONFIG_PATH || "";
process.env.FONTCONFIG_FILE = path.join(fontDir, "fonts.conf");
// Write a minimal fontconfig that includes our font directory
fs.writeFileSync(path.join(fontDir, "fonts.conf"), `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>`);

// Meme text system: auto-scaling + per-character animation
const FONT_METRICS = {
  pizzascript: { letterW: 48, spaceW: 22, family: "Pizzascript Sneps", caps: false, topY: 0.85 },
  impact:      { letterW: 52, spaceW: 16, family: "Impact", caps: true, topY: 1.05 },
};
const MEME_MAX_FONT = { pizzascript: 80, impact: 64 };
const MEME_MIN_FONT = 30;
const MEME_BOUNCE_PX = 4; // bounce offset in pixels

function memeTextWidth(text, fs, font = "pizzascript") {
  const m = FONT_METRICS[font] || FONT_METRICS.pizzascript;
  let w = 0;
  for (const ch of text) w += (ch === " " ? m.spaceW : m.letterW);
  return w * fs / 100;
}

function memeFont(text, font = "pizzascript") {
  const m = FONT_METRICS[font] || FONT_METRICS.pizzascript;
  if (m.caps) text = text.toUpperCase();
  const targetWidth = DEFAULT_SIZE * 0.9;
  const w100 = memeTextWidth(text, 100, font);
  const sz = Math.round((targetWidth / w100) * 100);
  const maxFont = MEME_MAX_FONT[font] || MEME_MAX_FONT.pizzascript;
  return Math.max(MEME_MIN_FONT, Math.min(maxFont, sz));
}

function getCharOffset(charIndex, phase, style, bounceAmt) {
  switch (style) {
    case "bounce":
      return (charIndex + phase) % 2 === 1 ? bounceAmt : 0;
    case "tapeworm": {
      const wavePos = (charIndex + phase) % 4;
      if (wavePos === 1) return -bounceAmt;
      if (wavePos === 3) return bounceAmt;
      return 0;
    }
    case "random": {
      const r = ((charIndex * 2654435761) >>> 0) % 100;
      if (r < 25) return (phase + charIndex) % 2 === 0 ? -bounceAmt : 0;
      if (r < 50) return (phase + charIndex) % 2 === 1 ? bounceAmt : 0;
      return 0;
    }
    default:
      return 0;
  }
}

function memeFrameCount(style) {
  if (style === "bounce" || style === "random") return 2;
  if (style === "tapeworm") return 4;
  return 1;
}

// Render a line of text as individual <text> elements with per-char Y offsets
function renderMemeLine(text, baseY, phase, style, font = "pizzascript") {
  const m = FONT_METRICS[font] || FONT_METRICS.pizzascript;
  const fs = memeFont(text, font);
  const sw = Math.max(3, Math.round(fs / 12));
  const letterW = m.letterW * fs / 100;
  const spaceW = m.spaceW * fs / 100;
  const totalW = memeTextWidth(text, fs, font);
  const startX = (DEFAULT_SIZE - totalW) / 2;
  const bounce = Math.round(MEME_BOUNCE_PX * fs / 50);

  let elements = "";
  let ci = 0;
  let x = startX;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== " ") {
      const yOff = getCharOffset(ci, phase, style, bounce);
      const y = Math.round(baseY + yOff);
      elements += `<text x="${Math.round(x)}" y="${y}" font-family="${m.family}" font-size="${fs}" fill="white" stroke="black" stroke-width="${sw}" paint-order="stroke">${escapeXml(ch)}</text>`;
      x += letterW;
      ci++;
    } else {
      x += spaceW;
    }
  }
  return elements;
}

function buildMemeOverlaySvg(topText, bottomText, phase = 0, style = "normal", font = "pizzascript") {
  const m = FONT_METRICS[font] || FONT_METRICS.pizzascript;
  if (m.caps) {
    if (topText) topText = topText.toUpperCase();
    if (bottomText) bottomText = bottomText.toUpperCase();
  }
  const size = DEFAULT_SIZE;
  let textElements = "";
  if (topText) {
    const fs = memeFont(topText, font);
    const baseY = Math.round(fs * m.topY);
    if (style === "normal") {
      const sw = Math.max(3, Math.round(fs / 12));
      textElements += `<text x="${size / 2}" y="${baseY}" text-anchor="middle" font-family="${m.family}" font-size="${fs}" fill="white" stroke="black" stroke-width="${sw}" paint-order="stroke">${escapeXml(topText)}</text>`;
    } else {
      textElements += renderMemeLine(topText, baseY, phase, style, font);
    }
  }
  if (bottomText) {
    const fs = memeFont(bottomText, font);
    const baseY = size - Math.round(fs * 0.25);
    if (style === "normal") {
      const sw = Math.max(3, Math.round(fs / 12));
      textElements += `<text x="${size / 2}" y="${baseY}" text-anchor="middle" font-family="${m.family}" font-size="${fs}" fill="white" stroke="black" stroke-width="${sw}" paint-order="stroke">${escapeXml(bottomText)}</text>`;
    } else {
      textElements += renderMemeLine(bottomText, baseY, phase, style, font);
    }
  }

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  ${textElements}
</svg>`);
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const COMRADE_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/pizza-comrades/pc_64px_noBG/";
const CDC_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/call-data-comrades/cdc_32px/";
const CDC_NOBG_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/call-data-comrades/cdc_32px_noBG/";
const COTD_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/comrades-of-the-dead/cotd_32px/";
const COTD_NOBG_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/comrades-of-the-dead/cotd_32px_noBG/";
const PC_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/pizza-comrades/pc_64px/";

// Cache original images briefly so button clicks can re-render at different sizes
const imageCache = new Map();

// Map of item number -> filename from the repo
const comradeIndex = new Map();
const cdcIndex = new Map(); // number -> { sub, filename } (subcategory path)
const cdcNoBgIndex = new Map(); // number -> { sub, filename } (noBG versions for animation)
const cotdIndex = new Map(); // number -> filename
const cotdNoBgIndex = new Map(); // number -> filename (noBG versions for animation)
const pcIndex = new Map(); // number -> filename

let cityBg = null;
let cityBgWidth = 0;
let cityBgBlur = null;
let cityBgBlurWidth = 0;
let cityBgNight = null;
let cityBgNightWidth = 0;
let pizzaTownBg = null;
let pizzaTownBgWidth = 0;
let nyanBuffer = null;
let gmOverlay400 = null; // 400x400 RGBA raw buffer with GM bubble positioned

// CDC animation backgrounds
const cdcBackgrounds = {};
const CDC_BG_FILES = {
  drain_plains_1: { file: "drain_plains.webp", label: "Drain Plains 1" },
  drain_plains_2: { file: "DrainPlains_wide_04.webp", label: "Drain Plains 2" },
  block_city: { file: "Block_City_wide_Glow.webp", label: "Block City" },
  beach_club: { file: "beachcity.png", label: "Beach Club" },
  blood_moon: { file: "Blood_Moon_over_Block_City_wide.png", label: "Blood Moon" },
  full_moon: { file: "Full_Moon_over_Block_City_wide.webp", label: "Full Moon" },
};

async function loadComradeIndex() {
  // Resolve the latest tree SHA for the target directory via the Git Trees API (recursive)
  const headers = { "User-Agent": "comrade400-bot" };
  const branchResp = await fetch(
    "https://api.github.com/repos/NoMoreLabs/Comrades/git/trees/main?recursive=1",
    { headers }
  );
  const branchData = await branchResp.json();
  const dir = branchData.tree.find(
    (t) => t.path === "art/pizza-comrades/pc_64px_noBG" && t.type === "tree"
  );
  if (!dir) {
    console.error("Could not find pc_64px_noBG directory in repo tree");
    return;
  }
  // Fetch that subtree to get all files (no 1000-item cap)
  const treeResp = await fetch(
    `https://api.github.com/repos/NoMoreLabs/Comrades/git/trees/${dir.sha}`,
    { headers }
  );
  const treeData = await treeResp.json();
  for (const item of treeData.tree) {
    const match = item.path.match(/#(\d+)\.\w+$/);
    if (match) {
      comradeIndex.set(parseInt(match[1]), item.path);
    }
  }
  console.log(`Comrade index loaded: ${comradeIndex.size} items`);
}

async function loadCollectionIndex(dirPath, indexMap, useSubfolders = false) {
  const headers = { "User-Agent": "comrade400-bot" };
  const branchResp = await fetch(
    "https://api.github.com/repos/NoMoreLabs/Comrades/git/trees/main?recursive=1",
    { headers }
  );
  const branchData = await branchResp.json();

  if (useSubfolders) {
    // CDC has subcategories — scan all subtrees under dirPath
    const subDirs = branchData.tree.filter(
      (t) => t.path.startsWith(dirPath + "/") && t.type === "tree"
    );
    for (const sub of subDirs) {
      const subName = sub.path.replace(dirPath + "/", "");
      const treeResp = await fetch(
        `https://api.github.com/repos/NoMoreLabs/Comrades/git/trees/${sub.sha}`,
        { headers }
      );
      const treeData = await treeResp.json();
      for (const item of treeData.tree) {
        const match = item.path.match(/#(\d+)\.\w+$/);
        if (match) {
          indexMap.set(parseInt(match[1]), { sub: subName, filename: item.path });
        }
      }
    }
  } else {
    const dir = branchData.tree.find(
      (t) => t.path === dirPath && t.type === "tree"
    );
    if (!dir) {
      console.error(`Could not find ${dirPath} in repo tree`);
      return;
    }
    const treeResp = await fetch(
      `https://api.github.com/repos/NoMoreLabs/Comrades/git/trees/${dir.sha}`,
      { headers }
    );
    const treeData = await treeResp.json();
    for (const item of treeData.tree) {
      const match = item.path.match(/#(\d+)\.\w+$/);
      if (match) {
        indexMap.set(parseInt(match[1]), item.path);
      }
    }
  }
  console.log(`Index loaded for ${dirPath}: ${indexMap.size} items`);
}

function fetchFromIndex(indexMap, baseUrl, itemNumber, useSubfolders = false) {
  const entry = indexMap.get(itemNumber);
  if (!entry) return null;
  let url;
  if (useSubfolders) {
    url = baseUrl + entry.sub + "/" + encodeURIComponent(entry.filename);
  } else {
    url = baseUrl + encodeURIComponent(entry);
  }
  return fetch(url).then((r) => (r.ok ? r.arrayBuffer().then(Buffer.from) : null));
}

async function fetchComrade(itemNumber) {
  const filename = comradeIndex.get(itemNumber);
  if (!filename) return null;
  const url = COMRADE_BASE_URL + encodeURIComponent(filename);
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return Buffer.from(await resp.arrayBuffer());
}

async function loadCityBackground() {
  const raw = await sharp(path.join(__dirname, "city_bg.webp"))
    .resize({ height: ANIM_SIZE, kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  cityBgWidth = raw.info.width;
  cityBg = raw.data;
  console.log(`City background loaded: ${cityBgWidth}x${ANIM_SIZE}`);

  const rawBlur = await sharp(path.join(__dirname, "city_bg_blur.webp"))
    .resize({ height: ANIM_SIZE, kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  cityBgBlurWidth = rawBlur.info.width;
  cityBgBlur = rawBlur.data;
  console.log(`City background (blur) loaded: ${cityBgBlurWidth}x${ANIM_SIZE}`);

  // Night mode: darken blur bg by 85%
  cityBgNight = Buffer.from(cityBgBlur);
  cityBgNightWidth = cityBgBlurWidth;
  for (let i = 0; i < cityBgNight.length; i += 4) {
    cityBgNight[i] = Math.round(cityBgNight[i] * 0.15);
    cityBgNight[i + 1] = Math.round(cityBgNight[i + 1] * 0.15);
    cityBgNight[i + 2] = Math.round(cityBgNight[i + 2] * 0.15);
  }
  console.log(`City background (night) loaded: ${cityBgNightWidth}x${ANIM_SIZE}`);

  const rawPizzaTown = await sharp(path.join(__dirname, "Pizza_Town_Cityscape_with_Sun_wide.webp"))
    .resize({ height: ANIM_SIZE, kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  pizzaTownBgWidth = rawPizzaTown.info.width;
  pizzaTownBg = rawPizzaTown.data;
  console.log(`Pizza Town background loaded: ${pizzaTownBgWidth}x${ANIM_SIZE}`);

  nyanBuffer = await sharp(path.join(__dirname, "nyan.png")).png().toBuffer();
  console.log("Nyan comrade loaded");

  // Load GM bubble and create 400x400 overlay
  const gmBubble = await sharp(path.join(__dirname, "gm_bubble.png"))
    .resize(128, 104, { kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer();
  // Create a 400x400 transparent canvas and place bubble at (255, 185)
  const gmCanvas = Buffer.alloc(DEFAULT_SIZE * DEFAULT_SIZE * 4, 0);
  const gmX = 255, gmY = 185, gmW = 128, gmH = 104;
  for (let y = 0; y < gmH; y++) {
    for (let x = 0; x < gmW; x++) {
      const srcIdx = (y * gmW + x) * 4;
      const dstIdx = ((gmY + y) * DEFAULT_SIZE + (gmX + x)) * 4;
      gmCanvas[dstIdx] = gmBubble[srcIdx];
      gmCanvas[dstIdx + 1] = gmBubble[srcIdx + 1];
      gmCanvas[dstIdx + 2] = gmBubble[srcIdx + 2];
      gmCanvas[dstIdx + 3] = gmBubble[srcIdx + 3];
    }
  }
  gmOverlay400 = gmCanvas;
  console.log("GM bubble overlay loaded (400x400)");

  // Load CDC backgrounds
  for (const [key, { file, label }] of Object.entries(CDC_BG_FILES)) {
    const raw = await sharp(path.join(__dirname, file))
      .resize({ height: ANIM_SIZE, kernel: sharp.kernel.nearest })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    cdcBackgrounds[key] = { data: raw.data, width: raw.info.width, label };
    console.log(`CDC background loaded: ${label} (${raw.info.width}x${ANIM_SIZE})`);
  }
}

// Composite GM bubble onto a 400x400 PNG buffer
async function applyGmOverlay(pngBuffer) {
  const overlay = await sharp(gmOverlay400, {
    raw: { width: DEFAULT_SIZE, height: DEFAULT_SIZE, channels: 4 },
  }).png().toBuffer();
  return sharp(pngBuffer)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// Pre-render all meme animation phases as raw RGBA buffers
async function renderMemePhases(topText, bottomText, style = "normal", font = "pizzascript") {
  const frames = memeFrameCount(style);
  const phases = [];
  for (let p = 0; p < frames; p++) {
    const svg = buildMemeOverlaySvg(topText, bottomText, p, style, font);
    const raw = await sharp(svg)
      .resize(DEFAULT_SIZE, DEFAULT_SIZE)
      .ensureAlpha()
      .raw()
      .toBuffer();
    phases.push(raw);
  }
  return phases;
}

// Apply meme text to a 400x400 PNG buffer (static, no animation)
async function applyMemeOverlay(pngBuffer, topText, bottomText, font = "pizzascript") {
  const svg = buildMemeOverlaySvg(topText, bottomText, 0, "normal", font);
  const overlay = await sharp(svg).png().toBuffer();
  return sharp(pngBuffer)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function cacheSet(key, buffer) {
  if (imageCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
  imageCache.set(key, buffer);
  setTimeout(() => imageCache.delete(key), 10 * 60 * 1000);
}


function makeButtons(sourceId, currentSize) {
  const row = new ActionRowBuilder();
  for (const size of SIZE_OPTIONS) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`resize_${sourceId}_${size}`)
        .setLabel(`${size}x${size}`)
        .setStyle(
          size === currentSize ? ButtonStyle.Primary : ButtonStyle.Secondary
        )
    );
  }
  return row;
}

async function resizeBuffer(buffer, size) {
  const meta = await sharp(buffer).metadata();
  const isAnimated = meta.pages && meta.pages > 1;
  let pipeline = sharp(buffer, { animated: isAnimated }).resize(size, size, {
    kernel: sharp.kernel.nearest,
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  if (meta.format === "gif" || isAnimated) {
    pipeline = pipeline.gif();
  } else if (meta.format === "webp") {
    pipeline = pipeline.webp();
  } else {
    pipeline = pipeline.png();
  }
  return pipeline.toBuffer();
}

function getExtension(contentType, name) {
  if (contentType?.includes("gif") || name?.endsWith(".gif")) return "gif";
  if (contentType?.includes("webp") || name?.endsWith(".webp")) return "webp";
  return "png";
}

function isSupported(contentType, name) {
  return (
    contentType?.startsWith("image/png") ||
    name?.endsWith(".png") ||
    contentType?.includes("gif") ||
    name?.endsWith(".gif") ||
    contentType?.includes("webp") ||
    name?.endsWith(".webp")
  );
}

// Build a 64x64 animated GIF: character over scrolling city background
async function buildAnimatedGif(charBuffer, rightToLeft, bg = cityBg, bgWidth = cityBgWidth, frameDelay = ANIM_FRAME_DELAY, useGm = false, memeTop = null, memeBottom = null, textStyle = "normal", font = "pizzascript") {
  // Pre-render meme overlay phases as raw RGBA if needed
  const memePhases = (memeTop || memeBottom) ? await renderMemePhases(memeTop, memeBottom, textStyle, font) : null;
  // Get character pixels at 64x64
  const charRaw = await sharp(charBuffer)
    .resize(ANIM_SIZE, ANIM_SIZE, {
      kernel: sharp.kernel.nearest,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const frameSize = ANIM_SIZE * ANIM_SIZE * 4;

  // Build all frames stacked vertically into one tall raw buffer
  const totalHeight = ANIM_SIZE * ANIM_FRAMES;
  const fullBuffer = Buffer.alloc(ANIM_SIZE * totalHeight * 4);

  for (let f = 0; f < ANIM_FRAMES; f++) {
    // Use fractional step so frame 0 and ANIM_FRAMES align perfectly for seamless loop
    let offset;
    if (rightToLeft) {
      offset = Math.round(bgWidth - (f * bgWidth) / ANIM_FRAMES) % bgWidth;
    } else {
      offset = Math.round((f * bgWidth) / ANIM_FRAMES) % bgWidth;
    }

    const frameStart = f * frameSize;

    for (let y = 0; y < ANIM_SIZE; y++) {
      for (let x = 0; x < ANIM_SIZE; x++) {
        const bgX = (offset + x) % bgWidth;
        const bgIdx = (y * bgWidth + bgX) * 4;
        const charIdx = (y * ANIM_SIZE + x) * 4;
        const outIdx = frameStart + (y * ANIM_SIZE + x) * 4;

        const charAlpha = charRaw[charIdx + 3] / 255;
        if (charAlpha > 0.5) {
          fullBuffer[outIdx] = charRaw[charIdx];
          fullBuffer[outIdx + 1] = charRaw[charIdx + 1];
          fullBuffer[outIdx + 2] = charRaw[charIdx + 2];
          fullBuffer[outIdx + 3] = 255;
        } else {
          fullBuffer[outIdx] = bg[bgIdx];
          fullBuffer[outIdx + 1] = bg[bgIdx + 1];
          fullBuffer[outIdx + 2] = bg[bgIdx + 2];
          fullBuffer[outIdx + 3] = bg[bgIdx + 3];
        }
      }
    }
  }

  // Upscale each frame to 400x400
  const upscaledFrames = [];
  for (let f = 0; f < ANIM_FRAMES; f++) {
    const frameStart = f * frameSize;
    const frameData = fullBuffer.subarray(frameStart, frameStart + frameSize);
    const upscaled = await sharp(frameData, {
      raw: { width: ANIM_SIZE, height: ANIM_SIZE, channels: 4 },
    })
      .resize(DEFAULT_SIZE, DEFAULT_SIZE, { kernel: sharp.kernel.nearest })
      .raw()
      .toBuffer();
    // Composite overlays onto upscaled frame
    const sz = DEFAULT_SIZE * DEFAULT_SIZE * 4;
    if (useGm && gmOverlay400) {
      for (let i = 0; i < sz; i += 4) {
        if (gmOverlay400[i + 3] > 0) {
          upscaled[i] = gmOverlay400[i];
          upscaled[i + 1] = gmOverlay400[i + 1];
          upscaled[i + 2] = gmOverlay400[i + 2];
          upscaled[i + 3] = gmOverlay400[i + 3];
        }
      }
    }
    if (memePhases) {
      // Cycle through text animation phases (e.g. every 8 frames for bounce)
      const phaseCount = memePhases.length;
      const framesPerPhase = Math.max(1, Math.floor(ANIM_FRAMES / (phaseCount * 8)));
      const phase = Math.floor(f / framesPerPhase) % phaseCount;
      const memeRaw = memePhases[phase];
      for (let i = 0; i < sz; i += 4) {
        const a = memeRaw[i + 3];
        if (a > 0) {
          upscaled[i] = memeRaw[i];
          upscaled[i + 1] = memeRaw[i + 1];
          upscaled[i + 2] = memeRaw[i + 2];
          upscaled[i + 3] = a;
        }
      }
    }
    upscaledFrames.push(upscaled);
  }
  const delays = new Array(upscaledFrames.length).fill(frameDelay);
  const bigBuffer = Buffer.concat(upscaledFrames);
  const bigTotalHeight = DEFAULT_SIZE * upscaledFrames.length;
  return sharp(bigBuffer, {
    raw: { width: DEFAULT_SIZE, height: bigTotalHeight, channels: 4, pageHeight: DEFAULT_SIZE },
  })
    .gif({ loop: 0, delay: delays, pageHeight: DEFAULT_SIZE })
    .toBuffer();
}

// Build a scrolling city background GIF with no character
async function buildBgGif(rightToLeft, bg = cityBg, bgWidth = cityBgWidth) {
  const frameSize = ANIM_SIZE * ANIM_SIZE * 4;
  const fullBuffer = Buffer.alloc(frameSize * ANIM_FRAMES);

  for (let f = 0; f < ANIM_FRAMES; f++) {
    let offset;
    if (rightToLeft) {
      offset = Math.round(bgWidth - (f * bgWidth) / ANIM_FRAMES) % bgWidth;
    } else {
      offset = Math.round((f * bgWidth) / ANIM_FRAMES) % bgWidth;
    }
    const frameStart = f * frameSize;
    for (let y = 0; y < ANIM_SIZE; y++) {
      for (let x = 0; x < ANIM_SIZE; x++) {
        const bgX = (offset + x) % bgWidth;
        const bgIdx = (y * bgWidth + bgX) * 4;
        const outIdx = frameStart + (y * ANIM_SIZE + x) * 4;
        fullBuffer[outIdx] = bg[bgIdx];
        fullBuffer[outIdx + 1] = bg[bgIdx + 1];
        fullBuffer[outIdx + 2] = bg[bgIdx + 2];
        fullBuffer[outIdx + 3] = bg[bgIdx + 3];
      }
    }
  }

  const upscaledFrames = [];
  for (let f = 0; f < ANIM_FRAMES; f++) {
    const frameStart = f * frameSize;
    const frameData = fullBuffer.subarray(frameStart, frameStart + frameSize);
    const upscaled = await sharp(frameData, {
      raw: { width: ANIM_SIZE, height: ANIM_SIZE, channels: 4 },
    })
      .resize(DEFAULT_SIZE, DEFAULT_SIZE, { kernel: sharp.kernel.nearest })
      .raw()
      .toBuffer();
    upscaledFrames.push(upscaled);
  }
  const delays = new Array(upscaledFrames.length).fill(ANIM_FRAME_DELAY);
  const bigBuffer = Buffer.concat(upscaledFrames);
  const bigTotalHeight = DEFAULT_SIZE * upscaledFrames.length;
  return sharp(bigBuffer, {
    raw: { width: DEFAULT_SIZE, height: bigTotalHeight, channels: 4, pageHeight: DEFAULT_SIZE },
  })
    .gif({ loop: 0, delay: delays, pageHeight: DEFAULT_SIZE })
    .toBuffer();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands
  const pizzaCommand = new SlashCommandBuilder()
    .setName("pizza")
    .setDescription("Pizza Comrades — display or animate")
    .addSubcommand((sub) =>
      sub
        .setName("display")
        .setDescription("Display a Pizza Comrade at 400x400")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("Item number").setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt.setName("gm").setDescription("Add GM speech bubble").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("top").setDescription(`Top meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("bottom").setDescription(`Bottom meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("animate")
        .setDescription("Animate a Pizza Comrade over a scrolling background")
        .addStringOption((opt) =>
          opt
            .setName("comrade")
            .setDescription("Search by name or item number")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("background")
            .setDescription("Choose a background")
            .setRequired(false)
            .addChoices(
              { name: "Pepperonia City", value: "pepperonia" },
              { name: "Pepperonia City (Blur)", value: "pepperonia_blur" },
              { name: "Night Mode", value: "night" },
              { name: "Pizza Town", value: "pizza_town" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("speed")
            .setDescription("Animation speed")
            .setRequired(false)
            .addChoices(
              { name: "Normal", value: "normal" },
              { name: "Fast (1.5x)", value: "fast" },
              { name: "Brawndor (2.2x)", value: "brawndor" },
              { name: "cryptoph03n1x (x69420)", value: "cryptoph03n1x" }
            )
        )
        .addBooleanOption((opt) =>
          opt
            .setName("rightleft")
            .setDescription("Scroll right-to-left instead of left-to-right")
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt.setName("gm").setDescription("Add GM speech bubble").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("top").setDescription(`Top meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("bottom").setDescription(`Bottom meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("textstyle").setDescription("Meme text animation style").setRequired(false)
            .addChoices(
              { name: "Normal", value: "normal" },
              { name: "Bounce", value: "bounce" },
              { name: "Tapeworm", value: "tapeworm" },
              { name: "Random", value: "random" }
            )
        )
        .addStringOption((opt) =>
          opt.setName("font").setDescription("Meme text font").setRequired(false)
            .addChoices(
              { name: "Pizzascript", value: "pizzascript" },
              { name: "Impact", value: "impact" }
            )
        )
    );

  const cdcCommand = new SlashCommandBuilder()
    .setName("cdc")
    .setDescription("Call Data Comrades — display or animate")
    .addSubcommand((sub) =>
      sub
        .setName("display")
        .setDescription("Display a Call Data Comrade at 400x400")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("Item number").setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt.setName("gm").setDescription("Add GM speech bubble").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("top").setDescription(`Top meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("bottom").setDescription(`Bottom meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("animate")
        .setDescription("Animate a Call Data Comrade over a background")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("Item number").setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("background")
            .setDescription("Choose a background")
            .setRequired(true)
            .addChoices(
              { name: "Drain Plains 1", value: "drain_plains_1" },
              { name: "Drain Plains 2", value: "drain_plains_2" },
              { name: "Block City", value: "block_city" },
              { name: "Beach Club", value: "beach_club" },
              { name: "Blood Moon", value: "blood_moon" },
              { name: "Full Moon", value: "full_moon" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("speed")
            .setDescription("Animation speed")
            .setRequired(false)
            .addChoices(
              { name: "Normal", value: "normal" },
              { name: "Fast (1.5x)", value: "fast" },
              { name: "Brawndor (2.2x)", value: "brawndor" }
            )
        )
        .addBooleanOption((opt) =>
          opt
            .setName("rightleft")
            .setDescription("Scroll right-to-left instead of left-to-right")
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt.setName("gm").setDescription("Add GM speech bubble").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("top").setDescription(`Top meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("bottom").setDescription(`Bottom meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("textstyle").setDescription("Meme text animation style").setRequired(false)
            .addChoices(
              { name: "Normal", value: "normal" },
              { name: "Bounce", value: "bounce" },
              { name: "Tapeworm", value: "tapeworm" },
              { name: "Random", value: "random" }
            )
        )
        .addStringOption((opt) =>
          opt.setName("font").setDescription("Meme text font").setRequired(false)
            .addChoices(
              { name: "Pizzascript", value: "pizzascript" },
              { name: "Impact", value: "impact" }
            )
        )
    );

  const cotdCommand = new SlashCommandBuilder()
    .setName("cotd")
    .setDescription("Comrades of the Dead — display or animate")
    .addSubcommand((sub) =>
      sub
        .setName("display")
        .setDescription("Display a Comrade of the Dead at 400x400")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("Item number").setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt.setName("gm").setDescription("Add GM speech bubble").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("top").setDescription(`Top meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("bottom").setDescription(`Bottom meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("font").setDescription("Meme text font").setRequired(false)
            .addChoices(
              { name: "Pizzascript", value: "pizzascript" },
              { name: "Impact", value: "impact" }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("animate")
        .setDescription("Animate a Comrade of the Dead over a background")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("Item number").setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("background")
            .setDescription("Choose a background")
            .setRequired(true)
            .addChoices(
              { name: "Drain Plains 1", value: "drain_plains_1" },
              { name: "Drain Plains 2", value: "drain_plains_2" },
              { name: "Block City", value: "block_city" },
              { name: "Beach Club", value: "beach_club" },
              { name: "Blood Moon", value: "blood_moon" },
              { name: "Full Moon", value: "full_moon" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("speed")
            .setDescription("Animation speed")
            .setRequired(false)
            .addChoices(
              { name: "Normal", value: "normal" },
              { name: "Fast", value: "fast" },
              { name: "Brawndor", value: "brawndor" }
            )
        )
        .addBooleanOption((opt) =>
          opt
            .setName("rightleft")
            .setDescription("Scroll right-to-left instead of left-to-right")
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt.setName("gm").setDescription("Add GM speech bubble").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("top").setDescription(`Top meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("bottom").setDescription(`Bottom meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
        )
        .addStringOption((opt) =>
          opt.setName("textstyle").setDescription("Meme text animation style").setRequired(false)
            .addChoices(
              { name: "Normal", value: "normal" },
              { name: "Bounce", value: "bounce" },
              { name: "Tapeworm", value: "tapeworm" },
              { name: "Random", value: "random" }
            )
        )
        .addStringOption((opt) =>
          opt.setName("font").setDescription("Meme text font").setRequired(false)
            .addChoices(
              { name: "Pizzascript", value: "pizzascript" },
              { name: "Impact", value: "impact" }
            )
        )
    );

  const nyanCommand = new SlashCommandBuilder()
    .setName("nyan")
    .setDescription("Nyan Comrade animation over Pepperonia City")
    .addBooleanOption((opt) =>
      opt
        .setName("rightleft")
        .setDescription("Scroll right-to-left instead of left-to-right")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt.setName("gm").setDescription("Add GM speech bubble").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("top").setDescription(`Top meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
    )
    .addStringOption((opt) =>
      opt.setName("bottom").setDescription(`Bottom meme text (max ${MEME_MAX_CHARS} chars)`).setRequired(false).setMaxLength(MEME_MAX_CHARS)
    )
    .addStringOption((opt) =>
      opt.setName("textstyle").setDescription("Meme text animation style").setRequired(false)
        .addChoices(
          { name: "Normal", value: "normal" },
          { name: "Bounce", value: "bounce" },
          { name: "Tapeworm", value: "tapeworm" },
          { name: "Random", value: "random" }
        )
    )
    .addStringOption((opt) =>
      opt.setName("font").setDescription("Meme text font").setRequired(false)
        .addChoices(
          { name: "Pizzascript", value: "pizzascript" },
          { name: "Impact", value: "impact" }
        )
    );

  const comrade400Command = new SlashCommandBuilder()
    .setName("comrade400")
    .setDescription("Comrade400 Bot — info & help")
    .addSubcommand((sub) =>
      sub
        .setName("help")
        .setDescription("Show how to use the bot")
    );

  const bgCommand = new SlashCommandBuilder()
    .setName("bg")
    .setDescription("Show a scrolling background animation")
    .addStringOption((opt) =>
      opt
        .setName("background")
        .setDescription("Choose a background")
        .setRequired(true)
        .addChoices(
          { name: "Pepperonia City", value: "pepperonia" },
          { name: "Pepperonia City (Blur)", value: "pepperonia_blur" },
          { name: "Night Mode", value: "night" },
          { name: "Drain Plains 1", value: "drain_plains_1" },
          { name: "Drain Plains 2", value: "drain_plains_2" },
          { name: "Block City", value: "block_city" },
          { name: "Beach Club", value: "beach_club" },
          { name: "Blood Moon", value: "blood_moon" },
          { name: "Full Moon", value: "full_moon" },
          { name: "Pizza Town", value: "pizza_town" }
        )
    )
    .addBooleanOption((opt) =>
      opt
        .setName("rightleft")
        .setDescription("Scroll right-to-left instead of left-to-right")
        .setRequired(false)
    );

  const verifyCommand = new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify your Ethscriptions wallet holdings and get holder roles");

  const rest = new REST().setToken(TOKEN);
  const guildId = "1369930881267142686";
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
    body: [
      pizzaCommand.toJSON(), cdcCommand.toJSON(), cotdCommand.toJSON(),
      nyanCommand.toJSON(), bgCommand.toJSON(), comrade400Command.toJSON(),
      verifyCommand.toJSON(),
    ],
  });
  // Clear any stale global commands
  await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
  console.log("Registered all commands (guild), cleared global commands");
});

// Auto-resize on image upload
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  for (const attachment of message.attachments.values()) {
    if (!isSupported(attachment.contentType, attachment.name)) continue;

    try {
      const response = await fetch(attachment.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(buffer).metadata();

      const isSmall =
        metadata.width <= MAX_SOURCE_SIZE &&
        metadata.height <= MAX_SOURCE_SIZE;
      if (isSmall) {
        const cacheKey = attachment.id;
        cacheSet(cacheKey, buffer);

        const ext = getExtension(attachment.contentType, attachment.name);
        const resized = await resizeBuffer(buffer, DEFAULT_SIZE);
        const file = new AttachmentBuilder(resized, {
          name: `upscaled_${DEFAULT_SIZE}x${DEFAULT_SIZE}.${ext}`,
        });

        await message.reply({
          files: [file],
          components: [makeButtons(cacheKey, DEFAULT_SIZE)],
        });
      }
    } catch (err) {
      console.error(`Failed to process ${attachment.name}:`, err.message);
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  // Autocomplete: /pizza animate comrade
  if (interaction.isAutocomplete() && interaction.commandName === "pizza") {
    const query = interaction.options.getFocused().toLowerCase().trim();

    if (!query) {
      const featured = [];
      for (const [num, filename] of comradeIndex) {
        const name = filename.replace(/\.\w+$/, "");
        if (!name.startsWith("Pizza Comrade")) {
          featured.push({ name, value: String(num) });
        }
        if (featured.length >= 25) break;
      }
      await interaction.respond(featured);
      return;
    }

    const startsWith = [];
    const includes = [];
    const numMatch = [];

    for (const [num, filename] of comradeIndex) {
      const label = filename.replace(/\.\w+$/, "");
      const lower = label.toLowerCase();
      const numStr = String(num);
      const entry = { name: label, value: numStr };

      if (lower.startsWith(query)) {
        startsWith.push(entry);
      } else if (lower.includes(query)) {
        includes.push(entry);
      } else if (numStr.startsWith(query)) {
        numMatch.push(entry);
      }
    }

    const combined = [...startsWith, ...includes, ...numMatch].slice(0, 25);
    await interaction.respond(combined);
    return;
  }

  // Slash command: /comrade400 help
  if (interaction.isChatInputCommand() && interaction.commandName === "comrade400") {
    const helpText = [
      "# Comrade400 Bot",
      "",
      "## Auto-Upscale",
      "Drop a small image (PNG/GIF/WebP, 128x128 or smaller) and the bot upscales it to 400x400. Use the buttons to resize to 400, 512, or 640.",
      "",
      "## Commands",
      "",
      "### `/pizza display id:<number>`",
      "Show a Pizza Comrade at 400x400.",
      "",
      "### `/pizza animate comrade:<name or number>`",
      "Animate a Pizza Comrade over a scrolling background.",
      "- **background** — Pepperonia City, Pepperonia City (Blur), Night Mode, Pizza Town",
      "- **speed** — Normal, Fast (1.5x), Brawndor (2.2x), cryptoph03n1x (max)",
      "",
      "### `/cdc display id:<number>`",
      "Show a Call Data Comrade at 400x400.",
      "",
      "### `/cdc animate id:<number> background:<choice>`",
      "Animate a Call Data Comrade. Backgrounds: Drain Plains 1 & 2, Block City, Beach Club, Blood Moon, Full Moon.",
      "",
      "### `/cotd display id:<number>`",
      "Show a Comrade of the Dead at 400x400.",
      "",
      "### `/cotd animate id:<number> background:<choice>`",
      "Animate a Comrade of the Dead. Same backgrounds as `/cdc`.",
      "",
      "### `/nyan`",
      "Nyan Comrade animation over Pepperonia City.",
      "",
      "### `/bg background:<choice>`",
      "Scrolling background with no character. All 10 backgrounds available.",
      "",
      "### `/verify`",
      "Verify your Ethscriptions wallet holdings. Sign a message to prove ownership, then get roles based on your CDC / COTD holdings.",
      "",
      "## Extras (work on any command)",
      "- **gm** — adds a GM speech bubble",
      "- **top / bottom** — meme text (max 20 chars each)",
      "- **font** — Pizzascript (default) or Impact (ALL CAPS)",
      "- **textstyle** — Normal, Bounce, Tapeworm, or Random",
      "- **rightleft** — scroll right-to-left instead",
    ].join("\n");

    await interaction.reply({ content: helpText, ephemeral: true });
    return;
  }

  // Slash command: /verify
  if (interaction.isChatInputCommand() && interaction.commandName === "verify") {
    const nonce = generateNonce();

    verifyNonces.set(interaction.user.id, {
      nonce,
      timestamp: Date.now(),
    });

    const verifyUrl = `${VERIFY_SITE}/verify?nonce=${nonce}&guild=${encodeURIComponent(interaction.guild.name)}&user=${encodeURIComponent(interaction.user.username)}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Connect Wallet & Sign")
        .setStyle(ButtonStyle.Link)
        .setURL(verifyUrl),
      new ButtonBuilder()
        .setCustomId("verify_check")
        .setLabel("Check Verification")
        .setStyle(ButtonStyle.Success)
    );

    await interaction.reply({
      content: [
        "**Wallet Verification**",
        "",
        "1. Click **Connect Wallet & Sign** to open the verification page",
        "2. Connect your wallet and sign the message",
        "3. Come back here and click **Check Verification**",
      ].join("\n"),
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // Button: check verification status
  if (interaction.isButton() && interaction.customId === "verify_check") {
    const stored = verifyNonces.get(interaction.user.id);
    if (!stored || Date.now() - stored.timestamp > NONCE_TTL) {
      await interaction.reply({
        content: "Verification expired. Run `/verify` again.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const res = await fetch(`${VERIFY_API}?nonce=${stored.nonce}`);
      const data = await res.json();

      if (!data.verified) {
        await interaction.editReply(
          "Not verified yet. Complete the signing on the website, then click **Check Verification** again."
        );
        return;
      }

      verifyNonces.delete(interaction.user.id);

      if (!data.holdings || data.holdings.length === 0) {
        await interaction.editReply(
          `Wallet \`${data.address}\` verified but holds no tracked collections.`
        );
        return;
      }

      const roles = await ensureRoles(interaction.guild);
      const added = [];

      for (const h of data.holdings) {
        const role = roles[h.name];
        if (role && !interaction.member.roles.cache.has(role.id)) {
          await interaction.member.roles.add(role);
          added.push(role.name);
        }
      }

      const lines = data.holdings.map(
        (h) => `**${h.name}** — ${h.balance} held`
      );
      const roleText =
        added.length > 0
          ? `\nRoles assigned: ${added.join(", ")}`
          : "\nYou already have all applicable roles.";

      await interaction.editReply(
        `Wallet \`${data.address}\` verified!\n\n${lines.join("\n")}${roleText}`
      );
    } catch (err) {
      console.error("Verify check error:", err.message);
      await interaction.editReply("Failed to check verification. Try again.");
    }
    return;
  }

  // Slash command: /cdc (subcommands: display, animate)
  if (interaction.isChatInputCommand() && interaction.commandName === "cdc") {
    await interaction.deferReply();
    const subcommand = interaction.options.getSubcommand();
    const id = interaction.options.getInteger("id");

    const useGm = interaction.options.getBoolean("gm") ?? false;
    const memeTop = interaction.options.getString("top") ?? null;
    const memeBottom = interaction.options.getString("bottom") ?? null;
    const textStyle = interaction.options.getString("textstyle") ?? "normal";
    const font = interaction.options.getString("font") ?? "pizzascript";

    if (subcommand === "display") {
      const buffer = await fetchFromIndex(cdcIndex, CDC_BASE_URL, id, true);
      if (!buffer) {
        await interaction.deleteReply();
        await interaction.followUp({ content: `CDC #${id} not found.`, ephemeral: true });
        return;
      }
      try {
        let resized = await resizeBuffer(buffer, DEFAULT_SIZE);
        if (useGm) resized = await applyGmOverlay(resized);
        if (memeTop || memeBottom) resized = await applyMemeOverlay(resized, memeTop, memeBottom, font);
        const file = new AttachmentBuilder(resized, { name: `cdc_${id}.png` });
        await interaction.editReply({ content: `**Call Data Comrade #${id}**`, files: [file] });
      } catch (err) {
        console.error("CDC display failed:", err.message);
        await interaction.deleteReply();
        await interaction.followUp({ content: "Failed to process image.", ephemeral: true });
      }
    } else if (subcommand === "animate") {
      const buffer = await fetchFromIndex(cdcNoBgIndex, CDC_NOBG_BASE_URL, id, true);
      if (!buffer) {
        await interaction.deleteReply();
        await interaction.followUp({ content: `CDC #${id} not found (noBG).`, ephemeral: true });
        return;
      }
      const bgKey = interaction.options.getString("background");
      const speedChoice = interaction.options.getString("speed") ?? "normal";
      const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;
      const bg = cdcBackgrounds[bgKey];

      const frameDelay = speedChoice === "fast" ? 60 : speedChoice === "brawndor" ? 40 : ANIM_FRAME_DELAY;
      const speedLabel = speedChoice === "fast" ? " ⚡" : speedChoice === "brawndor" ? " 🔥" : "";

      try {
        const gif = await buildAnimatedGif(buffer, rightToLeft, bg.data, bg.width, frameDelay, useGm, memeTop, memeBottom, textStyle, font);
        const direction = rightToLeft ? "→" : "←";
        const file = new AttachmentBuilder(gif, { name: `cdc_${id}_${bgKey}.gif` });
        await interaction.editReply({
          content: `**Call Data Comrade #${id}** ${direction} — ${bg.label}${speedLabel}`,
          files: [file],
        });
      } catch (err) {
        console.error("CDC animate failed:", err.message);
        await interaction.deleteReply();
        await interaction.followUp({ content: "Failed to create animation.", ephemeral: true });
      }
    }
    return;
  }

  // Slash command: /pizza (subcommands: display, animate)
  if (interaction.isChatInputCommand() && interaction.commandName === "pizza") {
    await interaction.deferReply();
    const subcommand = interaction.options.getSubcommand();

    const useGm = interaction.options.getBoolean("gm") ?? false;
    const memeTop = interaction.options.getString("top") ?? null;
    const memeBottom = interaction.options.getString("bottom") ?? null;
    const textStyle = interaction.options.getString("textstyle") ?? "normal";
    const font = interaction.options.getString("font") ?? "pizzascript";

    if (subcommand === "display") {
      const id = interaction.options.getInteger("id");
      const buffer = await fetchFromIndex(pcIndex, PC_BASE_URL, id);
      if (!buffer) {
        await interaction.deleteReply();
        await interaction.followUp({ content: `Pizza Comrade #${id} not found.`, ephemeral: true });
        return;
      }
      try {
        let resized = await resizeBuffer(buffer, DEFAULT_SIZE);
        if (useGm) resized = await applyGmOverlay(resized);
        if (memeTop || memeBottom) resized = await applyMemeOverlay(resized, memeTop, memeBottom, font);
        const file = new AttachmentBuilder(resized, { name: `pizza_${id}.png` });
        await interaction.editReply({ content: `**Pizza Comrade #${id}**`, files: [file] });
      } catch (err) {
        console.error("Pizza display failed:", err.message);
        await interaction.deleteReply();
        await interaction.followUp({ content: "Failed to process image.", ephemeral: true });
      }
    } else if (subcommand === "animate") {
      const input = interaction.options.getString("comrade")?.trim() ?? "";
      const bgChoice = interaction.options.getString("background") ?? "pepperonia";
      const speedChoice = interaction.options.getString("speed") ?? "normal";
      const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;

      let itemNumber = parseInt(input);
      if (isNaN(itemNumber)) {
        const lower = input.toLowerCase();
        for (const [num, filename] of comradeIndex) {
          const name = filename.replace(/\.\w+$/, "").toLowerCase();
          if (name.includes(lower)) {
            itemNumber = num;
            break;
          }
        }
      }

      if (isNaN(itemNumber) || !comradeIndex.has(itemNumber)) {
        await interaction.deleteReply();
        await interaction.followUp({ content: `Comrade "${input}" not found. Try typing a name or number and pick from the dropdown.`, ephemeral: true });
        return;
      }

      const comradeName = comradeIndex.get(itemNumber);

      try {
        const buffer = await fetchComrade(itemNumber);
        if (!buffer) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Failed to download Comrade #${itemNumber}.`, ephemeral: true });
          return;
        }

        const bg = bgChoice === "night" ? cityBgNight : bgChoice === "pepperonia_blur" ? cityBgBlur : bgChoice === "pizza_town" ? pizzaTownBg : cityBg;
        const bgW = bgChoice === "night" ? cityBgNightWidth : bgChoice === "pepperonia_blur" ? cityBgBlurWidth : bgChoice === "pizza_town" ? pizzaTownBgWidth : cityBgWidth;
        const frameDelay = speedChoice === "cryptoph03n1x" ? 20 : speedChoice === "fast" ? 60 : speedChoice === "brawndor" ? 40 : ANIM_FRAME_DELAY;
        const speedLabel = speedChoice === "cryptoph03n1x" ? " 💀" : speedChoice === "fast" ? " ⚡" : speedChoice === "brawndor" ? " 🔥" : "";
        const bgLabel = bgChoice === "night" ? " (Night)" : bgChoice === "pepperonia_blur" ? " (Blur)" : bgChoice === "pizza_town" ? " (Pizza Town)" : "";

        const gif = await buildAnimatedGif(buffer, rightToLeft, bg, bgW, frameDelay, useGm, memeTop, memeBottom, textStyle, font);
        const direction = rightToLeft ? "→" : "←";
        const label = comradeName.replace(/\.\w+$/, "");
        const file = new AttachmentBuilder(gif, {
          name: `${label.replace(/[^a-zA-Z0-9]/g, "_")}.gif`,
        });

        await interaction.editReply({
          content: `**${label}** ${direction}${bgLabel}${speedLabel}`,
          files: [file],
        });
      } catch (err) {
        console.error("Pizza animate failed:", err.message);
        await interaction.deleteReply();
        await interaction.followUp({ content: "Failed to create animation.", ephemeral: true });
      }
    }
    return;
  }

  // Slash command: /cotd (subcommands: display, animate)
  if (interaction.isChatInputCommand() && interaction.commandName === "cotd") {
    await interaction.deferReply();
    const subcommand = interaction.options.getSubcommand();
    const id = interaction.options.getInteger("id");

    const useGm = interaction.options.getBoolean("gm") ?? false;
    const memeTop = interaction.options.getString("top") ?? null;
    const memeBottom = interaction.options.getString("bottom") ?? null;
    const font = interaction.options.getString("font") ?? "pizzascript";

    if (subcommand === "display") {
      const buffer = await fetchFromIndex(cotdIndex, COTD_BASE_URL, id);
      if (!buffer) {
        await interaction.deleteReply();
        await interaction.followUp({ content: `Comrade of the Dead #${id} not found.`, ephemeral: true });
        return;
      }
      try {
        let resized = await resizeBuffer(buffer, DEFAULT_SIZE);
        if (useGm) resized = await applyGmOverlay(resized);
        if (memeTop || memeBottom) resized = await applyMemeOverlay(resized, memeTop, memeBottom, font);
        const file = new AttachmentBuilder(resized, { name: `cotd_${id}.png` });
        await interaction.editReply({ content: `**Comrade of the Dead #${id}**`, files: [file] });
      } catch (err) {
        console.error("COTD display failed:", err.message);
        await interaction.deleteReply();
        await interaction.followUp({ content: "Failed to process image.", ephemeral: true });
      }
    } else if (subcommand === "animate") {
      const buffer = await fetchFromIndex(cotdNoBgIndex, COTD_NOBG_BASE_URL, id);
      if (!buffer) {
        await interaction.deleteReply();
        await interaction.followUp({ content: `Comrade of the Dead #${id} not found (noBG).`, ephemeral: true });
        return;
      }
      const bgKey = interaction.options.getString("background");
      const speedChoice = interaction.options.getString("speed") ?? "normal";
      const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;
      const textStyle = interaction.options.getString("textstyle") ?? "normal";
      const bg = cdcBackgrounds[bgKey];

      const frameDelay = speedChoice === "fast" ? 60 : speedChoice === "brawndor" ? 40 : ANIM_FRAME_DELAY;
      const speedLabel = speedChoice === "fast" ? " ⚡" : speedChoice === "brawndor" ? " 🔥" : "";

      try {
        const gif = await buildAnimatedGif(buffer, rightToLeft, bg.data, bg.width, frameDelay, useGm, memeTop, memeBottom, textStyle, font);
        const direction = rightToLeft ? "→" : "←";
        const file = new AttachmentBuilder(gif, { name: `cotd_${id}_${bgKey}.gif` });
        await interaction.editReply({
          content: `**Comrade of the Dead #${id}** ${direction} — ${bg.label}${speedLabel}`,
          files: [file],
        });
      } catch (err) {
        console.error("COTD animate failed:", err.message);
        await interaction.deleteReply();
        await interaction.followUp({ content: "Failed to create animation.", ephemeral: true });
      }
    }
    return;
  }

  // Slash command: /nyan
  if (interaction.isChatInputCommand() && interaction.commandName === "nyan") {
    await interaction.deferReply();
    const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;
    const useGm = interaction.options.getBoolean("gm") ?? false;
    const memeTop = interaction.options.getString("top") ?? null;
    const memeBottom = interaction.options.getString("bottom") ?? null;
    const textStyle = interaction.options.getString("textstyle") ?? "normal";
    const font = interaction.options.getString("font") ?? "pizzascript";
    try {
      const gif = await buildAnimatedGif(nyanBuffer, rightToLeft, cityBg, cityBgWidth, ANIM_FRAME_DELAY, useGm, memeTop, memeBottom, textStyle, font);
      const direction = rightToLeft ? "→" : "←";
      const file = new AttachmentBuilder(gif, { name: "nyan_comrade.gif" });
      await interaction.editReply({
        content: `**Nyan Comrade** ${direction}`,
        files: [file],
      });
    } catch (err) {
      console.error("Nyan failed:", err.message);
      await interaction.deleteReply();
      await interaction.followUp({ content: "Failed to create animation.", ephemeral: true });
    }
    return;
  }

  // Slash command: /bg
  if (interaction.isChatInputCommand() && interaction.commandName === "bg") {
    await interaction.deferReply();
    const bgChoice = interaction.options.getString("background");
    const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;

    let bg, bgW, bgName;
    if (bgChoice === "pepperonia_blur") {
      bg = cityBgBlur; bgW = cityBgBlurWidth; bgName = "Pepperonia City (Blur)";
    } else if (bgChoice === "night") {
      bg = cityBgNight; bgW = cityBgNightWidth; bgName = "Night Mode";
    } else if (bgChoice === "pizza_town") {
      bg = pizzaTownBg; bgW = pizzaTownBgWidth; bgName = "Pizza Town";
    } else if (cdcBackgrounds[bgChoice]) {
      const entry = cdcBackgrounds[bgChoice];
      bg = entry.data; bgW = entry.width; bgName = entry.label;
    } else {
      bg = cityBg; bgW = cityBgWidth; bgName = "Pepperonia City";
    }

    try {
      const gif = await buildBgGif(rightToLeft, bg, bgW);
      const direction = rightToLeft ? "→" : "←";
      const file = new AttachmentBuilder(gif, { name: "background.gif" });
      await interaction.editReply({
        content: `**${bgName}** ${direction}`,
        files: [file],
      });
    } catch (err) {
      console.error("BG failed:", err.message);
      await interaction.deleteReply();
      await interaction.followUp({ content: "Failed to create background animation.", ephemeral: true });
    }
    return;
  }

  // Button: resize
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("resize_")) return;

  const parts = interaction.customId.split("_");
  const sourceId = parts[1];
  const size = parseInt(parts[2]);

  const buffer = imageCache.get(sourceId);
  if (!buffer) {
    await interaction.reply({
      content: "Image expired — re-upload the original to resize again.",
      ephemeral: true,
    });
    return;
  }

  try {
    const metadata = await sharp(buffer).metadata();
    const ext =
      metadata.format === "gif"
        ? "gif"
        : metadata.format === "webp"
          ? "webp"
          : "png";
    const resized = await resizeBuffer(buffer, size);
    const file = new AttachmentBuilder(resized, {
      name: `upscaled_${size}x${size}.${ext}`,
    });

    await interaction.update({
      files: [file],
      components: [makeButtons(sourceId, size)],
    });
  } catch (err) {
    console.error("Failed to resize on button click:", err.message);
  }
});

Promise.all([
  loadCityBackground(),
  loadComradeIndex(),
  loadCollectionIndex("art/call-data-comrades/cdc_32px", cdcIndex, true),
  loadCollectionIndex("art/call-data-comrades/cdc_32px_noBG", cdcNoBgIndex, true),
  loadCollectionIndex("art/comrades-of-the-dead/cotd_32px", cotdIndex),
  loadCollectionIndex("art/comrades-of-the-dead/cotd_32px_noBG", cotdNoBgIndex),
  loadCollectionIndex("art/pizza-comrades/pc_64px", pcIndex),
]).then(() => client.login(TOKEN));
