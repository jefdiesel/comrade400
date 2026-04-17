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
const CDC_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/call-data-comrades/cdc_32px/";
const CDC_NOBG_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/call-data-comrades/cdc_32px_noBG/";
const COTD_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/comrades-of-the-dead/cotd_32px/";
const PC_BASE_URL =
  "https://raw.githubusercontent.com/NoMoreLabs/Comrades/main/art/pizza-comrades/pc_64px/";

// Cache original images briefly so button clicks can re-render at different sizes
const imageCache = new Map();

// Map of item number -> filename from the repo
const comradeIndex = new Map();
const cdcIndex = new Map(); // number -> { sub, filename } (subcategory path)
const cdcNoBgIndex = new Map(); // number -> { sub, filename } (noBG versions for animation)
const cotdIndex = new Map(); // number -> filename
const pcIndex = new Map(); // number -> filename

let cityBg = null;
let cityBgWidth = 0;
let cityBgBlur = null;
let cityBgBlurWidth = 0;
let nyanBuffer = null;


// CDC animation backgrounds
const cdcBackgrounds = {};
const CDC_BG_FILES = {
  drain_plains_1: { file: "drain_plains.webp", label: "Drain Plains 1" },
  drain_plains_2: { file: "DrainPlains_wide_04.webp", label: "Drain Plains 2" },
  block_city: { file: "Block_City_wide_Glow.webp", label: "Block City" },
  beach_club: { file: "beachcity.png", label: "Beach Club" },
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

  nyanBuffer = await sharp(path.join(__dirname, "nyan.png")).png().toBuffer();
  console.log("Nyan comrade loaded");


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
async function buildAnimatedGif(charBuffer, rightToLeft, bg = cityBg, bgWidth = cityBgWidth, frameDelay = ANIM_FRAME_DELAY) {
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
              { name: "Pepperonia City (Blur)", value: "pepperonia_blur" }
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
              { name: "Beach Club", value: "beach_club" }
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
    );

  const cotdCommand = new SlashCommandBuilder()
    .setName("cotd")
    .setDescription("Display a Comrade of the Dead at 400x400")
    .addIntegerOption((opt) =>
      opt.setName("id").setDescription("Item number").setRequired(true)
    );

  const nyanCommand = new SlashCommandBuilder()
    .setName("nyan")
    .setDescription("Nyan Comrade animation over Pepperonia City")
    .addBooleanOption((opt) =>
      opt
        .setName("rightleft")
        .setDescription("Scroll right-to-left instead of left-to-right")
        .setRequired(false)
    );

  const rest = new REST().setToken(TOKEN);
  const guildId = "1369930881267142686";
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
    body: [
      pizzaCommand.toJSON(), cdcCommand.toJSON(), cotdCommand.toJSON(),
      nyanCommand.toJSON(),
    ],
  });
  console.log("Registered all commands (guild)");
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

  // Slash command: /cdc (subcommands: display, animate)
  if (interaction.isChatInputCommand() && interaction.commandName === "cdc") {
    await interaction.deferReply();
    const subcommand = interaction.options.getSubcommand();
    const id = interaction.options.getInteger("id");

    if (subcommand === "display") {
      const buffer = await fetchFromIndex(cdcIndex, CDC_BASE_URL, id, true);
      if (!buffer) {
        await interaction.deleteReply();
        await interaction.followUp({ content: `CDC #${id} not found.`, ephemeral: true });
        return;
      }
      try {
        const resized = await resizeBuffer(buffer, DEFAULT_SIZE);
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
        const gif = await buildAnimatedGif(buffer, rightToLeft, bg.data, bg.width, frameDelay);
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

    if (subcommand === "display") {
      const id = interaction.options.getInteger("id");
      const buffer = await fetchFromIndex(pcIndex, PC_BASE_URL, id);
      if (!buffer) {
        await interaction.deleteReply();
        await interaction.followUp({ content: `Pizza Comrade #${id} not found.`, ephemeral: true });
        return;
      }
      try {
        const resized = await resizeBuffer(buffer, DEFAULT_SIZE);
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

        const bg = bgChoice === "pepperonia_blur" ? cityBgBlur : cityBg;
        const bgW = bgChoice === "pepperonia_blur" ? cityBgBlurWidth : cityBgWidth;
        const frameDelay = speedChoice === "cryptoph03n1x" ? 20 : speedChoice === "fast" ? 60 : speedChoice === "brawndor" ? 40 : ANIM_FRAME_DELAY;
        const speedLabel = speedChoice === "cryptoph03n1x" ? " 💀" : speedChoice === "fast" ? " ⚡" : speedChoice === "brawndor" ? " 🔥" : "";
        const bgLabel = bgChoice === "pepperonia_blur" ? " (Blur)" : "";

        const gif = await buildAnimatedGif(buffer, rightToLeft, bg, bgW, frameDelay);
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

  // Slash command: /cotd
  if (interaction.isChatInputCommand() && interaction.commandName === "cotd") {
    await interaction.deferReply();
    const id = interaction.options.getInteger("id");
    const buffer = await fetchFromIndex(cotdIndex, COTD_BASE_URL, id);
    if (!buffer) {
      await interaction.deleteReply();
      await interaction.followUp({ content: `Comrade of the Dead #${id} not found.`, ephemeral: true });
      return;
    }
    try {
      const resized = await resizeBuffer(buffer, DEFAULT_SIZE);
      const file = new AttachmentBuilder(resized, { name: `cotd_${id}.png` });
      await interaction.editReply({ content: `**Comrade of the Dead #${id}**`, files: [file] });
    } catch (err) {
      console.error("COTD failed:", err.message);
      await interaction.deleteReply();
      await interaction.followUp({ content: "Failed to process image.", ephemeral: true });
    }
    return;
  }

  // Slash command: /nyan
  if (interaction.isChatInputCommand() && interaction.commandName === "nyan") {
    await interaction.deferReply();
    const rightToLeft = interaction.options.getBoolean("rightleft") ?? false;
    try {
      const gif = await buildAnimatedGif(nyanBuffer, rightToLeft);
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
  loadCollectionIndex("art/pizza-comrades/pc_64px", pcIndex),
]).then(() => client.login(TOKEN));
