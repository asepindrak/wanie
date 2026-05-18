const { Telegraf, Input } = require("telegraf");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { prisma } = require("../database/client");
const toolCredentialService = require("./tool-credential-service");
const TelegramConfigService = require("./telegram-config-service");
const chatService = require("./chat-service");
const crmService = require("./crm-service");
const { mediaDir } = require("../utils/paths");

let bots = {}; // userId -> Telegraf instance
let ioInstance = null;

function getTelegramDisplayName(ctx) {
  return (
    [ctx.from?.first_name, ctx.from?.last_name]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ") ||
    ctx.from?.username ||
    "Telegram User"
  );
}

function isAdminChat(userId, telegramChatId) {
  const allowedIds = (
    TelegramConfigService.getConfig(userId)?.adminTelegramIds || []
  ).map(String);
  return allowedIds.length > 0 && allowedIds.includes(String(telegramChatId));
}

function hasWebhook(userId) {
  const webhookService = require("./webhook-service");
  const config = webhookService.getWebhook(userId);
  return Boolean(config?.url && config.enabled !== false);
}

function isAiReplyEnabled(userId) {
  const config = TelegramConfigService.getConfig(userId) || {};
  return config.aiReplyEnabled !== false;
}

function formatTelegramLocationMessage(location = {}) {
  const latitude = location.latitude;
  const longitude = location.longitude;
  if (latitude === undefined || longitude === undefined) {
    return "[Telegram location]";
  }

  const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
  return [
    "[Telegram location]",
    `Latitude: ${latitude}`,
    `Longitude: ${longitude}`,
    `Map: ${mapUrl}`,
  ].join("\n");
}

async function ensureTelegramUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    throw new Error(`Telegram bot owner user not found: ${userId}`);
  }
  return user;
}

async function ensureTelegramChat(userId, telegramChatId, displayName) {
  await ensureTelegramUser(userId);

  let contact = await prisma.contact.findFirst({
    where: {
      userId,
      externalId: `tg:${telegramChatId}`,
    },
  });

  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        userId,
        externalId: `tg:${telegramChatId}`,
        displayName,
        avatarUrl: null,
      },
    });
  }

  let chat = await prisma.chat.findFirst({
    where: {
      userId,
      contactId: contact.id,
    },
    include: {
      contact: true,
    },
  });

  if (!chat) {
    chat = await prisma.chat.create({
      data: {
        userId,
        title: contact.displayName,
        contactId: contact.id,
      },
      include: {
        contact: true,
      },
    });
  }

  return chat;
}

async function storeTelegramIncomingMessage({
  userId,
  telegramChatId,
  displayName,
  body,
  type = "text",
  mediaFileId = null,
  messageId,
}) {
  return chatService.storeIncomingMessage({
    userId,
    sessionId: null,
    sender: `tg:${telegramChatId}`,
    displayName,
    body,
    type,
    mediaFileId,
    externalMessageId: `telegram:${telegramChatId}:${messageId}`,
  });
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "application/pdf") return ".pdf";
  return "";
}

function getTelegramMediaDescriptor(ctx) {
  const message = ctx.message || {};
  const caption = String(message.caption || "").trim();

  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    return {
      fileId: photo.file_id,
      originalName: `${photo.file_unique_id || photo.file_id}.jpg`,
      mimeType: "image/jpeg",
      type: "image",
      caption,
    };
  }

  if (message.document) {
    return {
      fileId: message.document.file_id,
      originalName: message.document.file_name || "telegram-document",
      mimeType: message.document.mime_type || "application/octet-stream",
      type: "document",
      caption,
    };
  }

  if (message.video) {
    return {
      fileId: message.video.file_id,
      originalName: message.video.file_name || "telegram-video.mp4",
      mimeType: message.video.mime_type || "video/mp4",
      type: "video",
      caption,
    };
  }

  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      originalName: message.audio.file_name || "telegram-audio",
      mimeType: message.audio.mime_type || "audio/mpeg",
      type: "audio",
      caption,
    };
  }

  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      originalName: "telegram-voice.ogg",
      mimeType: message.voice.mime_type || "audio/ogg",
      type: "audio",
      caption,
    };
  }

  if (message.sticker) {
    return {
      fileId: message.sticker.file_id,
      originalName: `${message.sticker.file_unique_id || "telegram-sticker"}.webp`,
      mimeType: "image/webp",
      type: "sticker",
      caption,
    };
  }

  return null;
}

async function createTelegramMediaFile(userId, ctx, descriptor) {
  const link = await ctx.telegram.getFileLink(descriptor.fileId);
  const response = await fetch(link.href || String(link));
  if (!response.ok) {
    throw new Error(`Failed to download Telegram media: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  const ext =
    path.extname(descriptor.originalName) ||
    extensionFromMimeType(descriptor.mimeType) ||
    ".bin";
  const filename = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(mediaDir, filename);
  fs.writeFileSync(filePath, buffer);

  return chatService.createMediaFile(userId, {
    path: filePath,
    filename,
    originalname: descriptor.originalName,
    mimetype: descriptor.mimeType,
    size: buffer.length,
  });
}

function emitTelegramIncoming(incoming, userId) {
  if (!ioInstance) return;

  ioInstance.to(`user:${userId}`).emit("new_message", incoming.message);
  ioInstance.to(`user:${userId}`).emit("contact_list_update", incoming.chat);
}

async function notifyTelegramWebhook(userId, incoming) {
  const webhookService = require("./webhook-service");
  try {
    await webhookService.notifyWebhook(userId, {
      chat: incoming.chat,
      message: incoming.message,
    });
  } catch (error) {
    console.error("[TelegramService] Webhook delivery failed:", error);
  }
}

class TelegramService {
  static setIo(io) {
    ioInstance = io;
  }

  static async startBot(userId, token) {
    if (!token) throw new Error("Telegram bot token is required.");
    await ensureTelegramUser(userId);

    if (bots[userId]) {
      try {
        await bots[userId].stop();
      } catch (e) {}
    }

    const bot = new Telegraf(token);

    const handleCustomerMessage = async ({
      ctx,
      telegramChatId,
      displayName,
      body,
      type = "text",
      mediaFileId = null,
    }) => {
      const chat = await ensureTelegramChat(
        userId,
        telegramChatId,
        displayName,
      );
      const crmMode = await crmService.resolveModeForChat(userId, chat);

      const incoming = await storeTelegramIncomingMessage({
        userId,
        telegramChatId,
        displayName,
        body,
        type,
        mediaFileId,
        messageId: ctx.message.message_id,
      });

      emitTelegramIncoming(incoming, userId);
      await notifyTelegramWebhook(userId, incoming);

      if (!isAiReplyEnabled(userId)) {
        return;
      }

      if (crmMode === "off") {
        if (!hasWebhook(userId)) {
          await ctx.reply(
            "Halo, pesan Anda sudah diterima. Saat ini layanan bot otomatis sedang nonaktif, admin akan membalas dari dashboard.",
          );
        }
        return;
      }

      const crmAutoReplyService = require("./crm-auto-reply-service");
      try {
        await crmAutoReplyService.maybeAutoReply({
          userId,
          chat: incoming.chat,
          inboundMessage: incoming.message,
          io: ioInstance,
          userRoom: (id) => `user:${id}`,
        });
      } catch (error) {
        console.error("[TelegramService] CRM auto-reply failed:", error);
      }
    };

    bot.start((ctx) => {
      ctx.reply(
        "Halo! Pesan Anda sudah terhubung ke CRM. Tim kami akan membantu dari sini.",
      );
    });

    bot.on("text", async (ctx) => {
      try {
        const telegramChatId = String(ctx.chat.id);
        const text = ctx.message.text;
        const normalizedText = String(text || "").trim();
        const displayName = getTelegramDisplayName(ctx);
        const aiReplyEnabled = isAiReplyEnabled(userId);

        if (aiReplyEnabled && isAdminChat(userId, telegramChatId)) {
          // Admin chats keep the existing remote-assistant behavior.
          const chat = await ensureTelegramChat(
            userId,
            telegramChatId,
            displayName,
          );

          if (normalizedText.toLowerCase() === "/new") {
            const newChat = await chatService.createAssistantConversation(
              userId,
              {},
            );
            if (ioInstance) {
              ioInstance.to(`user:${userId}`).emit("contact_list_update", newChat);
            }
            await ctx.reply(
              "Konteks baru telah dimulai. Saya membuat sesi assistant baru untuk Anda.",
            );
            return;
          }

          const agentService = require("./agent-service");
          await agentService.handleAssistantMessage(
            userId,
            chat.id,
            { body: text },
            {
              transport: "telegram",
              telegramCtx: ctx,
              io: ioInstance,
            },
          );
          return;
        }

        await handleCustomerMessage({
          ctx,
          telegramChatId,
          displayName,
          body: normalizedText,
        });
      } catch (error) {
        console.error("[TelegramService] Telegram text handling failed:", error);
        if (/owner user not found/i.test(String(error?.message || ""))) {
          await TelegramService.stopBot(userId).catch(() => {});
          await toolCredentialService
            .removeCredentialForUser(userId, "telegram_bot")
            .catch(() => {});
        }
      }
    });

    bot.on("location", async (ctx) => {
      try {
        const telegramChatId = String(ctx.chat.id);
        const displayName = getTelegramDisplayName(ctx);
        const body = formatTelegramLocationMessage(ctx.message.location || {});

        await handleCustomerMessage({
          ctx,
          telegramChatId,
          displayName,
          body,
          type: "text",
        });
      } catch (error) {
        console.error("[TelegramService] Telegram location handling failed:", error);
        if (/owner user not found/i.test(String(error?.message || ""))) {
          await TelegramService.stopBot(userId).catch(() => {});
          await toolCredentialService
            .removeCredentialForUser(userId, "telegram_bot")
            .catch(() => {});
        }
      }
    });

    const handleTelegramMedia = async (ctx) => {
      try {
        const telegramChatId = String(ctx.chat.id);
        const displayName = getTelegramDisplayName(ctx);

        if (isAdminChat(userId, telegramChatId)) {
          await ctx.reply(
            "Media diterima, tapi kontrol admin Telegram saat ini hanya mendukung pesan teks.",
          );
          return;
        }

        const descriptor = getTelegramMediaDescriptor(ctx);
        if (!descriptor) return;

        const mediaFile = await createTelegramMediaFile(userId, ctx, descriptor);
        await handleCustomerMessage({
          ctx,
          telegramChatId,
          displayName,
          body: descriptor.caption || null,
          type: descriptor.type,
          mediaFileId: mediaFile.id,
        });
      } catch (error) {
        console.error("[TelegramService] Telegram media handling failed:", error);
        if (/owner user not found/i.test(String(error?.message || ""))) {
          await TelegramService.stopBot(userId).catch(() => {});
          await toolCredentialService
            .removeCredentialForUser(userId, "telegram_bot")
            .catch(() => {});
          return;
        }
        await ctx.reply(
          "Maaf, media belum bisa diproses saat ini. Silakan coba lagi atau kirim pesan teks.",
        );
      }
    };

    for (const mediaType of [
      "photo",
      "document",
      "video",
      "audio",
      "voice",
      "sticker",
    ]) {
      bot.on(mediaType, handleTelegramMedia);
    }

    bot.launch();
    bots[userId] = bot;
    console.info(`[TelegramService] Bot started for user ${userId}`);
    return bot;
  }

  static async initializeAll() {
    console.info("[TelegramService] Initializing all Telegram bots...");
    const store = toolCredentialService.readStore();
    for (const key in store) {
      if (key.startsWith("telegram_bot:")) {
        const [_, userId] = key.split(":");
        try {
          const cred = await toolCredentialService.getCredentialForUser(
            userId,
            "telegram_bot",
          );
          if (cred && cred.apiKey) {
            await TelegramService.startBot(userId, cred.apiKey);
          }
        } catch (e) {
          if (/owner user not found/i.test(String(e?.message || ""))) {
            await toolCredentialService
              .removeCredentialForUser(userId, "telegram_bot")
              .catch(() => {});
          }
          console.error(
            `[TelegramService] Failed to initialize bot for user ${userId}:`,
            e,
          );
        }
      }
    }
  }

  static async stopBot(userId) {
    if (bots[userId]) {
      try {
        await bots[userId].stop();
      } catch (e) {}
      delete bots[userId];
    }
  }

  static isBotRunning(userId) {
    return Boolean(bots[userId]);
  }

  static getBotStatus(userId) {
    const bot = bots[userId];
    return {
      running: Boolean(bot),
      username: bot?.botInfo?.username || null,
      id: bot?.botInfo?.id ? String(bot.botInfo.id) : null,
    };
  }

  static async stopAll() {
    console.info("[TelegramService] Stopping all Telegram bots...");
    for (const userId in bots) {
      await TelegramService.stopBot(userId);
    }
  }

  static async sendMessage(userId, telegramChatId, text) {
    const bot = bots[userId];
    if (!bot) {
      return false;
    }

    await bot.telegram.sendMessage(telegramChatId, text);
    return true;
  }

  static async sendMedia(userId, telegramChatId, mediaFile, caption) {
    const bot = bots[userId];
    if (!bot || !mediaFile) return false;

    const relativePath = String(mediaFile.relativePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .trim();
    const normalized = relativePath.startsWith("media/")
      ? relativePath.slice("media/".length)
      : relativePath;
    const filePath = path.join(mediaDir, normalized);

    if (fs.existsSync(filePath)) {
      const mimeType = String(mediaFile.mimeType || "").toLowerCase();
      if (mimeType.startsWith("image/")) {
        await bot.telegram.sendPhoto(
          telegramChatId,
          Input.fromLocalFile(filePath),
          {
            caption,
          },
        );
      } else if (mimeType.startsWith("video/")) {
        await bot.telegram.sendVideo(
          telegramChatId,
          Input.fromLocalFile(filePath),
          {
            caption,
          },
        );
      } else if (mimeType.startsWith("audio/")) {
        await bot.telegram.sendAudio(
          telegramChatId,
          Input.fromLocalFile(filePath),
          {
            caption,
          },
        );
      } else {
        await bot.telegram.sendDocument(
          telegramChatId,
          Input.fromLocalFile(filePath),
          { caption },
        );
      }
    } else {
      // Fallback to text if file missing
      await bot.telegram.sendMessage(
        telegramChatId,
        (caption ? caption + "\n" : "") + "[Media file missing]",
      );
    }

    return true;
  }

  static isTelegramChat(externalId) {
    return String(externalId || "").startsWith("tg:");
  }

  static extractTelegramId(externalId) {
    return String(externalId || "").replace(/^tg:/, "");
  }
}

module.exports = TelegramService;
