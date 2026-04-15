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

const ANIM_FRAMES = 32;
const ANIM_FRAME_DELAY = 100;
const ANIM_SIZE = 64;

// Cache original images briefly so button clicks can re-render at different sizes
const imageCache = new Map();

let cityBg = null;
let cityBgWidth = 0;

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

  const scrollStep = Math.max(1, Math.floor(cityBgWidth / ANIM_FRAMES));
  const frameSize = ANIM_SIZE * ANIM_SIZE * 4;

  // Build all frames stacked vertically into one tall raw buffer
  const totalHeight = ANIM_SIZE * ANIM_FRAMES;
  const fullBuffer = Buffer.alloc(ANIM_SIZE * totalHeight * 4);

  for (let f = 0; f < ANIM_FRAMES; f++) {
    let offset;
    if (rightToLeft) {
      offset = (cityBgWidth - f * scrollStep) % cityBgWidth;
      if (offset < 0) offset += cityBgWidth;
    } else {
      offset = (f * scrollStep) % cityBgWidth;
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

  // Create animated GIF from stacked frames
  const delays = new Array(ANIM_FRAMES).fill(ANIM_FRAME_DELAY);
  return sharp(fullBuffer, {
    raw: { width: ANIM_SIZE, height: totalHeight, channels: 4 },
  })
    .gif({ loop: 0, delay: delays })
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
      "Animate a pixel art character over the Pepperonia City skyline"
    )
    .addAttachmentOption((opt) =>
      opt
        .setName("image")
        .setDescription("Character image (small pixel art)")
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("rightleft")
        .setDescription("Scroll right-to-left instead of left-to-right")
        .setRequired(false)
    );

  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: [command.toJSON()],
  });
  console.log("Registered /animate command");
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
  // Slash command: /animate
  if (interaction.isChatInputCommand() && interaction.commandName === "animate") {
    await interaction.deferReply();

    const attachment = interaction.options.getAttachment("image");
    const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;

    if (!isSupported(attachment.contentType, attachment.name)) {
      await interaction.editReply("Unsupported format — use PNG, GIF, or WebP.");
      return;
    }

    try {
      const response = await fetch(attachment.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(buffer).metadata();

      if (metadata.width > MAX_SOURCE_SIZE || metadata.height > MAX_SOURCE_SIZE) {
        await interaction.editReply(
          `Image too large (${metadata.width}x${metadata.height}). Max ${MAX_SOURCE_SIZE}x${MAX_SOURCE_SIZE}.`
        );
        return;
      }

      const gif = await buildAnimatedGif(buffer, rightToLeft);
      const direction = rightToLeft ? "right-to-left" : "left-to-right";
      const file = new AttachmentBuilder(gif, { name: "animated.gif" });

      await interaction.editReply({
        content: `64x64 animation (${direction})`,
        files: [file],
      });
    } catch (err) {
      console.error("Animate failed:", err.message);
      await interaction.editReply("Failed to create animation.");
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

loadCityBackground().then(() => client.login(TOKEN));
