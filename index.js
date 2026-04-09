const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const sharp = require("sharp");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("Set DISCORD_TOKEN environment variable");
  process.exit(1);
}

const TARGET_SIZE = 400;
const MAX_SOURCE_SIZE = 128; // only upscale images this small or smaller

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  for (const attachment of message.attachments.values()) {
    if (!attachment.contentType?.startsWith("image/png")) continue;

    try {
      const response = await fetch(attachment.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(buffer).metadata();

      if (
        metadata.width <= MAX_SOURCE_SIZE &&
        metadata.height <= MAX_SOURCE_SIZE
      ) {
        const resized = await sharp(buffer)
          .resize(TARGET_SIZE, TARGET_SIZE, {
            kernel: sharp.kernel.nearest,
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer();

        const file = new AttachmentBuilder(resized, {
          name: attachment.name || "upscaled.png",
        });

        await message.reply({ files: [file] });
      }
    } catch (err) {
      console.error(`Failed to process ${attachment.name}:`, err.message);
    }
  }
});

client.login(TOKEN);
