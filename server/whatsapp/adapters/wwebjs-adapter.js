const EventEmitter = require("events");
const QRCode = require("qrcode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { v4: uuidv4 } = require("uuid");
const {
  sessionsDir,
  storageDir,
  mediaDir,
  ensureRuntimeDirs,
} = require("../../utils/paths");
const { prisma } = require("../../database/client");
const chatService = require("../../services/chat-service");

function resolveStoredMediaPath(relativePath) {
  const normalized = String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();

  if (!normalized) {
    throw new Error("Media path is required.");
  }

  const withoutMediaPrefix = normalized.startsWith("media/")
    ? normalized.slice("media/".length)
    : normalized;

  return path.join(mediaDir, withoutMediaPrefix);
}

function isChromiumProfileLockError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("profile appears to be in use") ||
    message.includes("process_singleton") ||
    message.includes("singletonlock")
  );
}

function isLiveLocalSingletonLock(lockPath) {
  try {
    const target = fs.readlinkSync(lockPath);
    const match = String(target || "").match(/^(.+)-(\d+)$/);
    if (!match) return false;

    const [, host, pidValue] = match;
    if (host !== os.hostname()) return false;

    const pid = Number(pidValue);
    if (!Number.isInteger(pid) || pid <= 0) return false;

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  } catch (error) {
    return false;
  }
}

function clearStaleChromiumProfileLocks(sessionId) {
  const profileDir = path.join(sessionsDir, `session-${sessionId}`);
  if (!fs.existsSync(profileDir)) {
    return [];
  }

  const removed = [];
  const pending = [profileDir];
  while (pending.length) {
    const dir = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!entry.name.startsWith("Singleton")) continue;

      if (entry.name === "SingletonLock" && isLiveLocalSingletonLock(filePath)) {
        throw new Error(
          `Chromium profile is locked by a running local process. Stop that process before reconnecting: ${filePath}`,
        );
      }

      fs.rmSync(filePath, { force: true, recursive: true });
      removed.push(filePath);
    }
  }

  return removed;
}

function logRemovedProfileLocks(sessionId, removedLocks) {
  if (!removedLocks.length) return;
  console.warn(
    `[WwebjsAdapter] Removed stale Chromium profile locks for session ${sessionId}: ${removedLocks.join(", ")}`,
  );
}

function normalizeWwebjsMessageType(type) {
  const normalized = String(type || "text").toLowerCase();
  if (normalized === "location") return "text";
  if (normalized === "image") return "image";
  if (normalized === "video") return "video";
  if (normalized === "audio" || normalized === "ptt" || normalized === "voice")
    return "audio";
  if (normalized === "sticker") return "sticker";
  if (
    normalized === "document" ||
    normalized === "document_with_caption" ||
    normalized === "file"
  ) {
    return "document";
  }
  return "text";
}

function formatWwebjsLocationMessage(message) {
  const location = message?.location || {};
  const data = message?._data || {};
  const latitude = location.latitude ?? data.lat;
  const longitude = location.longitude ?? data.lng;

  if (latitude === undefined || longitude === undefined) {
    return null;
  }

  const name = location.name || "";
  const address = location.address || "";
  const description = location.description || data.loc || "";
  const url =
    location.url ||
    data.clientUrl ||
    `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
  const parts = [
    "[WhatsApp location]",
    name ? `Name: ${name}` : null,
    address ? `Address: ${address}` : null,
    !name && !address && description ? `Description: ${description}` : null,
    `Latitude: ${latitude}`,
    `Longitude: ${longitude}`,
    `Map: ${url}`,
  ].filter(Boolean);

  return parts.join("\n");
}

function isWwebjsLocationMessage(message) {
  return String(message?.type || "").toLowerCase() === "location";
}

function isWhatsAppPrivateId(externalId) {
  const normalized = String(externalId || "").toLowerCase();
  return normalized.endsWith("@c.us") || normalized.endsWith("@lid");
}

function isWhatsAppGroupId(externalId) {
  return String(externalId || "").toLowerCase().endsWith("@g.us");
}

function isWhatsAppConversationId(externalId) {
  return isWhatsAppPrivateId(externalId) || isWhatsAppGroupId(externalId);
}

class WwebjsAdapter extends EventEmitter {
  constructor({ session }) {
    super();
    this.session = session;
    this.client = null;
    this.inboundMessageIds = new Set();
  }

  async resolveProfilePic(externalId) {
    if (isWhatsAppGroupId(externalId)) {
      return {
        url: null,
        status: "skipped",
        reason: "group-profile-photo-skipped",
      };
    }

    if (!this.client || !externalId) {
      return {
        url: null,
        status: "missing",
        reason: "client-not-ready-or-empty-id",
      };
    }

    try {
      // Use official API instead of low-level evaluate
      const profilePicUrl = await this.client.getProfilePicUrl(externalId);

      if (!profilePicUrl) {
        return {
          url: null,
          status: "missing",
          reason: "no-profile-photo-returned",
        };
      }

      return {
        url: profilePicUrl,
        status: "found",
        reason: "profile-photo-found",
      };
    } catch (error) {
      const message = String(error?.message || error || "");
      console.warn(
        `[WwebjsAdapter] resolveProfilePic failed for ${externalId}:`,
        message,
      );

      return {
        url: null,
        status: "error",
        reason: message,
      };
    }
  }

  async resolveProfilePicUrl(externalId) {
    const result = await this.resolveProfilePic(externalId);
    if (result.status === "error") {
      console.warn(
        `Failed to fetch WhatsApp profile photo for ${externalId}: ${result.reason}`,
      );
    }

    return result.url;
  }

  rememberInboundMessage(externalMessageId) {
    if (!externalMessageId) return true;
    if (this.inboundMessageIds.has(externalMessageId)) return false;

    this.inboundMessageIds.add(externalMessageId);
    setTimeout(() => {
      this.inboundMessageIds.delete(externalMessageId);
    }, 5 * 60 * 1000).unref?.();
    return true;
  }

  async emitIncomingMessage(message) {
    const chatId = String(message.from || "");
    const isPrivateChat = isWhatsAppPrivateId(chatId);
    const isGroupChat = isWhatsAppGroupId(chatId);
    if (!isPrivateChat && !isGroupChat) return;

    const externalMessageId = message.id?._serialized || null;
    if (!this.rememberInboundMessage(externalMessageId)) return;

    let mediaFileId = null;
    let type = normalizeWwebjsMessageType(message.type);
    let body = message.body;
    const isLocation = isWwebjsLocationMessage(message);
    if (isLocation) {
      body = formatWwebjsLocationMessage(message) || "[WhatsApp location]";
      type = "text";
    }

    if (message.hasMedia && !isLocation) {
      try {
        const media = await message.downloadMedia();
        if (media && media.data) {
          if (!fs.existsSync(mediaDir))
            fs.mkdirSync(mediaDir, { recursive: true });
          const ext = media.mimetype.split("/")[1] || "bin";
          const filename = `${uuidv4()}.${ext}`;
          const filePath = path.join(mediaDir, filename);
          fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));
          const mediaFile = await prisma.mediaFile.create({
            data: {
              userId: this.session.userId,
              fileName: filename,
              originalName: filename,
              mimeType: media.mimetype,
              size: Buffer.from(media.data, "base64").length,
              relativePath: `media/${filename}`,
            },
          });
          mediaFileId = mediaFile.id;
          type = normalizeWwebjsMessageType(message.type);
          if (media.caption) body = media.caption;
        }
      } catch (err) {
        console.error("Failed to download WhatsApp media:", err);
      }
    }

    this.emit("message", {
      sender: chatId,
      displayName:
        message._data?.notifyName || message._data?.pushname || chatId,
      avatarUrl: isGroupChat ? null : await this.resolveProfilePicUrl(chatId),
      body,
      type,
      mediaFileId,
      externalMessageId,
    });
  }

  async connect({ skipProfileLockRetry = false } = {}) {
    try {
      ensureRuntimeDirs();
    } catch (e) {}

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.session.id,
        dataPath: sessionsDir,
      }),
      puppeteer: {
        headless: true,
        // Increase protocolTimeout to avoid Runtime.callFunctionOn timed out errors
        // when WhatsApp/puppeteer operations take longer on slow machines.
        protocolTimeout: 300000,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        timeout: 0,
      },
    });

    this.client.on("qr", async (qr) => {
      const qrCode = await QRCode.toDataURL(qr);
      this.emit("qr", { qrCode, transportType: "wwebjs" });
    });

    this.client.on("loading_screen", () => {
      this.emit("status", { status: "connecting", transportType: "wwebjs" });
    });

    this.client.on("ready", () => {
      const phoneNumber = this.client.info?.wid?.user || null;
      this.emit("status", {
        status: "ready",
        transportType: "wwebjs",
        phoneNumber,
      });
    });

    this.client.on("disconnected", (reason) => {
      this.emit("status", {
        status: "disconnected",
        transportType: "wwebjs",
        lastError: typeof reason === "string" ? reason : "Disconnected",
      });
    });

    this.client.on("auth_failure", (message) => {
      this.emit("status", {
        status: "error",
        transportType: "wwebjs",
        lastError: message,
      });
    });

    this.client.on("message", (message) => {
      void this.emitIncomingMessage(message).catch((error) => {
        console.error("Failed to process incoming WhatsApp message.", error);
      });
    });

    this.client.on("message_create", (message) => {
      void (async () => {
        if (!message.fromMe) {
          await this.emitIncomingMessage(message);
          return;
        }

        const receiver = String(message.to || "");
        const isPrivateChat = isWhatsAppPrivateId(receiver);
        const isGroupChat = isWhatsAppGroupId(receiver);
        if (!isPrivateChat && !isGroupChat) return;

        await chatService.storeExternalOutgoingMessage({
          userId: this.session.userId,
          sessionId: this.session.id,
          receiver,
          displayName: receiver,
          body: isWwebjsLocationMessage(message)
            ? formatWwebjsLocationMessage(message) || "[WhatsApp location]"
            : message.body || null,
          type: normalizeWwebjsMessageType(message.type),
          externalMessageId: message.id?._serialized || null,
        });
      })().catch((error) => {
        console.error("Failed to process outgoing WhatsApp message.", error);
      });
    });

    try {
      logRemovedProfileLocks(
        this.session.id,
        clearStaleChromiumProfileLocks(this.session.id),
      );
      await this.client.initialize();
    } catch (error) {
      if (skipProfileLockRetry || !isChromiumProfileLockError(error)) {
        throw error;
      }

      const removedLocks = clearStaleChromiumProfileLocks(this.session.id);
      logRemovedProfileLocks(this.session.id, removedLocks);

      try {
        await this.client.destroy();
      } catch (destroyError) {
        // Browser launch failed before a clean client existed.
      }
      this.client = null;
      await this.connect({ skipProfileLockRetry: true });
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    this.emit("status", { status: "disconnected", transportType: "wwebjs" });
  }

  async healthCheck() {
    if (!this.client) {
      return {
        ok: false,
        state: "NO_CLIENT",
        transportType: "wwebjs",
      };
    }

    const state =
      typeof this.client.getState === "function"
        ? await this.client.getState()
        : null;
    const normalizedState = String(state || "").toUpperCase();
    const hasIdentity = Boolean(this.client.info?.wid?._serialized);
    const ok =
      normalizedState === "CONNECTED" ||
      normalizedState === "OPENING" ||
      (hasIdentity && !["UNPAIRED", "UNLAUNCHED", "CONFLICT"].includes(normalizedState));

    return {
      ok,
      state: normalizedState || (hasIdentity ? "READY" : "UNKNOWN"),
      transportType: "wwebjs",
      phoneNumber: this.client.info?.wid?.user || null,
    };
  }

  async getSyncSnapshot() {
    if (!this.client) {
      throw new Error("WhatsApp client is not ready.");
    }

    // Wait for the client to be fully ready and for internal data to settle
    // whatsapp-web.js sometimes fires 'ready' but data isn't fully accessible
    await new Promise((resolve) => setTimeout(resolve, 10000));

    let contacts = [];
    let chats = [];
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        console.log(
          `[WwebjsAdapter] Syncing chats and contacts (attempt ${retryCount + 1})...`,
        );

        // Use official API methods
        contacts = await this.client.getContacts();
        chats = await this.client.getChats();

        if (chats && chats.length > 0) {
          console.log(
            `[WwebjsAdapter] Found ${chats.length} chats and ${contacts.length} contacts.`,
          );
          break;
        }

        throw new Error(
          "No chats found yet (WhatsApp might still be loading data).",
        );
      } catch (err) {
        retryCount++;
        const message = err.message || String(err);

        if (retryCount >= maxRetries) {
          console.error("[WwebjsAdapter] Sync failed after retries:", message);
          // Return empty to avoid crashing the whole session manager
          return { contacts: [], chats: [] };
        }

        console.warn(
          `[WwebjsAdapter] Sync attempt ${retryCount} failed: ${message}. Retrying in 5s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    // Limit chats to sync to avoid blocking the event loop for too long
    // Sort by timestamp if possible, or just take the first N
    const recentChats = chats
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 40);

    const contactSnapshots = await Promise.all(
      contacts.slice(0, 100).map(async (contact) => {
        const externalId = contact.id?._serialized || "";
        // Only fetch profile pic for some contacts to save time
        let avatarUrl = null;
        try {
          const avatarResult = await this.resolveProfilePic(externalId);
          avatarUrl = avatarResult.url;
        } catch (e) {
          // ignore
        }

        return {
          externalId,
          name: contact.name || contact.shortName || "",
          pushname: contact.pushname || contact.name || "",
          avatarUrl,
        };
      }),
    );

    const contactAvatarMap = new Map(
      contactSnapshots.map((contact) => [
        contact.externalId,
        contact.avatarUrl,
      ]),
    );
    const chatSnapshots = [];

    for (const chat of recentChats) {
      const externalId = chat?.id?._serialized || "";
      if (!externalId) {
        continue;
      }

      if (!isWhatsAppConversationId(externalId)) {
        continue;
      }

      if (typeof chat.fetchMessages !== "function") {
        console.warn(
          `[WwebjsAdapter] Skipping chat without fetchMessages support: ${externalId}`,
        );
        continue;
      }

      try {
        let messages = [];
        try {
          messages = await chat.fetchMessages({ limit: 20 });
        } catch (err) {
          console.warn(
            `[WwebjsAdapter] Failed to fetch messages for ${externalId}:`,
            err?.message || err,
          );
        }

        const chatAvatarResult = contactAvatarMap.get(externalId)
          ? {
              url: contactAvatarMap.get(externalId),
              status: "found",
              reason: "reused-contact-avatar",
            }
          : await this.resolveProfilePic(externalId);

        chatSnapshots.push({
          externalId,
          name: chat.name || chat.formattedTitle || externalId,
          pushname: chat.name || chat.formattedTitle || externalId,
          avatarUrl: chatAvatarResult.url,
          messages: Array.isArray(messages)
            ? messages.map((message) => ({
                externalMessageId: message.id?._serialized || null,
                sender: message.fromMe
                  ? `user:${this.session.userId}`
                  : message.author || message.from || externalId,
                body: isWwebjsLocationMessage(message)
                  ? formatWwebjsLocationMessage(message) || "[WhatsApp location]"
                  : message.body || null,
                type: normalizeWwebjsMessageType(message.type),
                direction: message.fromMe ? "outbound" : "inbound",
                ack: message.ack ?? 0,
                createdAt: new Date(
                  (message.timestamp || Math.floor(Date.now() / 1000)) * 1000,
                ).toISOString(),
              }))
            : [],
        });
      } catch (err) {
        console.warn(
          `[WwebjsAdapter] Skipping chat after sync error for ${externalId}:`,
          err?.message || err,
        );
      }
    }

    return {
      contacts: contactSnapshots,
      chats: chatSnapshots,
    };
  }

  async sendMessage(payload) {
    if (!this.client) {
      throw new Error("WhatsApp client is not ready.");
    }

    if (payload.mediaFileId) {
      const mediaPath = resolveStoredMediaPath(payload.mediaPath || "");

      if (!fs.existsSync(mediaPath)) {
        throw new Error(`Media file not found: ${mediaPath}`);
      }

      const media = MessageMedia.fromFilePath(mediaPath);
      const response = await this.client.sendMessage(
        payload.recipient,
        media,
        payload.body ? { caption: payload.body } : undefined,
      );
      return {
        externalMessageId: response.id?._serialized || null,
      };
    }

    const response = await this.client.sendMessage(
      payload.recipient,
      payload.body || "",
    );
    return {
      externalMessageId: response.id?._serialized || null,
    };
  }
}

module.exports = {
  WwebjsAdapter,
  __internal: {
    resolveStoredMediaPath,
  },
};
