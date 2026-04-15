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

const COMRADE_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/pizza-comrades/pc_64px_noBG/";

// Cache original images briefly so button clicks can re-render at different sizes
const imageCache = new Map();

// Map of item number -> filename from the repo
const comradeIndex = new Map();

let cityBg = null;
let cityBgWidth = 0;

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
async function buildAnimatedGif(charBuffer, rightToLeft) {
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
      offset = Math.round(cityBgWidth - (f * cityBgWidth) / ANIM_FRAMES) % cityBgWidth;
    } else {
      offset = Math.round((f * cityBgWidth) / ANIM_FRAMES) % cityBgWidth;
    }

    const frameStart = f * frameSize;

    for (let y = 0; y < ANIM_SIZE; y++) {
      for (let x = 0; x < ANIM_SIZE; x++) {
        const bgX = (offset + x) % cityBgWidth;
        const bgIdx = (y * cityBgWidth + bgX) * 4;
        const charIdx = (y * ANIM_SIZE + x) * 4;
        const outIdx = frameStart + (y * ANIM_SIZE + x) * 4;

        const charAlpha = charRaw[charIdx + 3] / 255;
        if (charAlpha > 0.5) {
          fullBuffer[outIdx] = charRaw[charIdx];
          fullBuffer[outIdx + 1] = charRaw[charIdx + 1];
          fullBuffer[outIdx + 2] = charRaw[charIdx + 2];
          fullBuffer[outIdx + 3] = 255;
        } else {
          fullBuffer[outIdx] = cityBg[bgIdx];
          fullBuffer[outIdx + 1] = cityBg[bgIdx + 1];
          fullBuffer[outIdx + 2] = cityBg[bgIdx + 2];
          fullBuffer[outIdx + 3] = cityBg[bgIdx + 3];
        }
      }
    }
  }

  // Upscale each frame to 400x400, duplicate each for smoother animation
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

// Build a scrolling city background GIF with no character
async function buildBgGif(rightToLeft) {
  const frameSize = ANIM_SIZE * ANIM_SIZE * 4;
  const fullBuffer = Buffer.alloc(frameSize * ANIM_FRAMES);

  for (let f = 0; f < ANIM_FRAMES; f++) {
    let offset;
    if (rightToLeft) {
      offset = Math.round(cityBgWidth - (f * cityBgWidth) / ANIM_FRAMES) % cityBgWidth;
    } else {
      offset = Math.round((f * cityBgWidth) / ANIM_FRAMES) % cityBgWidth;
    }
    const frameStart = f * frameSize;
    for (let y = 0; y < ANIM_SIZE; y++) {
      for (let x = 0; x < ANIM_SIZE; x++) {
        const bgX = (offset + x) % cityBgWidth;
        const bgIdx = (y * cityBgWidth + bgX) * 4;
        const outIdx = frameStart + (y * ANIM_SIZE + x) * 4;
        fullBuffer[outIdx] = cityBg[bgIdx];
        fullBuffer[outIdx + 1] = cityBg[bgIdx + 1];
        fullBuffer[outIdx + 2] = cityBg[bgIdx + 2];
        fullBuffer[outIdx + 3] = cityBg[bgIdx + 3];
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

  // Register slash command
  const command = new SlashCommandBuilder()
    .setName("animate")
    .setDescription(
      "Animate a Pizza Comrade over the Pepperonia City skyline"
    )
    .addStringOption((opt) =>
      opt
        .setName("comrade")
        .setDescription("Search by name or item number")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("rightleft")
        .setDescription("Scroll right-to-left instead of left-to-right")
        .setRequired(false)
    );

  const bgCommand = new SlashCommandBuilder()
    .setName("bg")
    .setDescription("Show the scrolling Pepperonia City skyline")
    .addBooleanOption((opt) =>
      opt
        .setName("rightleft")
        .setDescription("Scroll right-to-left instead of left-to-right")
        .setRequired(false)
    );

  const rest = new REST().setToken(TOKEN);
  const guildId = "1369930881267142686";
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
    body: [command.toJSON(), bgCommand.toJSON()],
  });
  console.log("Registered /animate and /bg commands (guild)");
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
  // Autocomplete: /animate comrade
  if (interaction.isAutocomplete() && interaction.commandName === "animate") {
    const query = interaction.options.getFocused().toLowerCase().trim();
    const results = [];

    if (!query) {
      // Show some notable named characters when empty
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

    // Exact name starts-with first, then includes, then number match
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

  // Slash command: /bg
  if (interaction.isChatInputCommand() && interaction.commandName === "bg") {
    await interaction.deferReply();
    const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;
    try {
      const gif = await buildBgGif(rightToLeft);
      const file = new AttachmentBuilder(gif, { name: "pepperonia_city.gif" });
      const direction = rightToLeft ? "→" : "←";
      await interaction.editReply({
        content: `**Pepperonia City** ${direction}`,
        files: [file],
      });
    } catch (err) {
      console.error("BG failed:", err.message);
      await interaction.deleteReply();
      await interaction.followUp({ content: "Failed to create background animation.", ephemeral: true });
    }
    return;
  }

  // Slash command: /animate
  if (interaction.isChatInputCommand() && interaction.commandName === "animate") {
    await interaction.deferReply();

    const input = interaction.options.getString("comrade")?.trim() ?? "";
    const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;
    console.log(`/animate input: "${input}"`);

    // Resolve input: could be a number from autocomplete or a typed name
    let itemNumber = parseInt(input);
    if (isNaN(itemNumber)) {
      // Search by name
      const lower = input.toLowerCase();
      for (const [num, filename] of comradeIndex) {
        const name = filename.replace(/\.\w+$/, "").toLowerCase();
        if (name.includes(lower)) {
          itemNumber = num;
          console.log(`Matched "${input}" -> #${num} (${filename})`);
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

      const gif = await buildAnimatedGif(buffer, rightToLeft);
      const direction = rightToLeft ? "→" : "←";
      const label = comradeName.replace(/\.\w+$/, "");
      const file = new AttachmentBuilder(gif, {
        name: `${label.replace(/[^a-zA-Z0-9]/g, "_")}.gif`,
      });

      await interaction.editReply({
        content: `**${label}** ${direction}`,
        files: [file],
      });
    } catch (err) {
      console.error("Animate failed:", err.message);
      await interaction.deleteReply();
      await interaction.followUp({ content: "Failed to create animation.", ephemeral: true });
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

Promise.all([loadCityBackground(), loadComradeIndex()]).then(() =>
  client.login(TOKEN)
);
