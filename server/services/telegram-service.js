const { Telegraf, Input } = require("telegraf");
const fs = require("fs");
const path = require("path");
const { prisma } = require("../database/client");
const toolCredentialService = require("./tool-credential-service");
const TelegramConfigService = require("./telegram-config-service");
const chatService = require("./chat-service");
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

class TelegramService {
  static setIo(io) {
    ioInstance = io;
  }

  static async startBot(userId, token) {
    if (bots[userId]) {
      try {
        await bots[userId].stop();
      } catch (e) {}
    }

    const bot = new Telegraf(token);

    bot.start((ctx) => {
      ctx.reply(
        "Halo! Pesan Anda sudah terhubung ke CRM. Tim kami akan membantu dari sini.",
      );
    });

    bot.on("text", async (ctx) => {
      const telegramChatId = String(ctx.chat.id);
      const text = ctx.message.text;
      const normalizedText = String(text || "").trim();

      if (isAdminChat(userId, telegramChatId)) {
        // Admin chats keep the existing remote-assistant behavior.
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
              displayName: getTelegramDisplayName(ctx),
              avatarUrl: null,
            },
          });
        }

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

        let chat = await prisma.chat.findFirst({
          where: {
            userId,
            contactId: contact.id,
          },
        });

        if (!chat) {
          chat = await prisma.chat.create({
            data: {
              userId,
              title: contact.displayName,
              contactId: contact.id,
            },
          });
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

      const incoming = await chatService.storeIncomingMessage({
        userId,
        sessionId: null,
        sender: `tg:${telegramChatId}`,
        displayName: getTelegramDisplayName(ctx),
        body: normalizedText,
        type: "text",
        externalMessageId: `telegram:${telegramChatId}:${ctx.message.message_id}`,
      });

      if (ioInstance) {
        ioInstance.to(`user:${userId}`).emit("new_message", incoming.message);
        ioInstance.to(`user:${userId}`).emit(
          "contact_list_update",
          incoming.chat,
        );
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
    });

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
