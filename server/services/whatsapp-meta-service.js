const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { prisma } = require("../database/client");
const chatService = require("./chat-service");
const webhookService = require("./webhook-service");
const crmAutoReplyService = require("./crm-auto-reply-service");
const { mediaDir, storageDir, ensureRuntimeDirs } = require("../utils/paths");

const CONFIG_PATH = path.join(storageDir, "whatsapp_meta_config.json");
const GRAPH_VERSION = process.env.WHATSAPP_META_GRAPH_VERSION || "v23.0";

function getEncryptionKey() {
  const secret =
    process.env.OPENWA_META_SECRET_KEY ||
    process.env.OPENWA_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "openwa-local-meta-secret";
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptSecret(value) {
  const text = String(value || "");
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (!text.startsWith("v1:")) return text;
  const [, ivRaw, tagRaw, encryptedRaw] = text.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) return "";
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivRaw, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function readStore() {
  try {
    ensureRuntimeDirs();
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8") || "{}");
  } catch (error) {
    console.error("[WhatsAppMeta] Failed to read config:", error);
    return {};
  }
}

function writeStore(store) {
  ensureRuntimeDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(store, null, 2), "utf8");
}

function normalizeConfigForRead(config) {
  if (!config) return null;
  return {
    phoneNumberId: config.phoneNumberId || "",
    businessAccountId: config.businessAccountId || "",
    verifyToken: config.verifyToken || "",
    appSecret: config.appSecretEncrypted ? decryptSecret(config.appSecretEncrypted) : "",
    accessToken: config.accessTokenEncrypted
      ? decryptSecret(config.accessTokenEncrypted)
      : "",
  };
}

function getSessionConfig(sessionId) {
  return normalizeConfigForRead(readStore()[String(sessionId)]);
}

function setSessionConfig(sessionId, config = {}) {
  const store = readStore();
  store[String(sessionId)] = {
    phoneNumberId: String(config.phoneNumberId || "").trim(),
    businessAccountId: String(config.businessAccountId || "").trim(),
    verifyToken: String(config.verifyToken || "").trim(),
    accessTokenEncrypted: encryptSecret(config.accessToken),
    appSecretEncrypted: encryptSecret(config.appSecret),
  };
  writeStore(store);
  return normalizeConfigForRead(store[String(sessionId)]);
}

function deleteSessionConfig(sessionId) {
  const store = readStore();
  delete store[String(sessionId)];
  writeStore(store);
}

function maskConfig(config) {
  if (!config) return null;
  return {
    phoneNumberId: config.phoneNumberId || "",
    businessAccountId: config.businessAccountId || "",
    verifyToken: config.verifyToken ? "configured" : "",
    hasAccessToken: Boolean(config.accessToken),
    hasAppSecret: Boolean(config.appSecret),
  };
}

function findVerifyToken(token) {
  const expected = String(token || "");
  if (!expected) return null;
  const store = readStore();
  const entry = Object.entries(store).find(
    ([, config]) => String(config.verifyToken || "") === expected,
  );
  return entry ? { sessionId: entry[0], config: normalizeConfigForRead(entry[1]) } : null;
}

async function findSessionByPhoneNumberId(phoneNumberId) {
  const target = String(phoneNumberId || "").trim();
  if (!target) return null;
  const store = readStore();
  const entry = Object.entries(store).find(
    ([, config]) => String(config.phoneNumberId || "") === target,
  );
  if (!entry) return null;
  const [sessionId] = entry;
  const session = await prisma.whatsappSession.findUnique({ where: { id: sessionId } });
  if (!session || session.transportType !== "whatsapp_cloud") return null;
  return { session, config: normalizeConfigForRead(store[sessionId]) };
}

function verifySignature(rawBody, appSecret, signature) {
  if (!appSecret || !signature || !rawBody) return true;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function externalIdForWaId(waId) {
  return `wa:${String(waId || "").replace(/\D/g, "")}`;
}

function normalizeRecipient(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("wa:")) return raw.slice(3).replace(/\D/g, "");
  if (raw.endsWith("@c.us") || raw.endsWith("@lid")) return raw.replace(/\D/g, "");
  return raw.replace(/\D/g, "");
}

function mapIncomingText(message) {
  if (message.type === "text") return message.text?.body || "";
  if (message.type === "button") return message.button?.text || "";
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      "[WhatsApp interactive reply]"
    );
  }
  if (message.type === "location") {
    const latitude = message.location?.latitude;
    const longitude = message.location?.longitude;
    const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
    return [
      "[WhatsApp location]",
      message.location?.name ? `Name: ${message.location.name}` : null,
      message.location?.address ? `Address: ${message.location.address}` : null,
      `Latitude: ${latitude}`,
      `Longitude: ${longitude}`,
      `Map: ${mapUrl}`,
    ].filter(Boolean).join("\n");
  }
  return message.caption || `[WhatsApp ${message.type || "message"}]`;
}

function mediaDescriptor(message) {
  const media = message.image || message.video || message.audio || message.document || message.sticker;
  if (!media?.id) return null;
  const type = message.type === "sticker" ? "sticker" : message.type;
  return {
    id: media.id,
    type,
    caption: media.caption || message.caption || "",
    mimeType: media.mime_type || "application/octet-stream",
    filename: media.filename || `whatsapp-${type}`,
  };
}

async function graphFetch(pathPart, config, options = {}) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pathPart.replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    throw new Error(`Meta Graph API failed ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function uploadMedia(mediaFile, config) {
  const relativePath = String(mediaFile.relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const fileName = relativePath.startsWith("media/")
    ? relativePath.slice("media/".length)
    : relativePath;
  const filePath = path.join(mediaDir, fileName);
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = `----openwa-meta-${crypto.randomUUID()}`;
  const fields = [
    { name: "messaging_product", value: "whatsapp" },
    { name: "type", value: mediaFile.mimeType || "application/octet-stream" },
  ];
  const chunks = [];
  for (const field of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${mediaFile.originalName || mediaFile.fileName || "file"}"\r\nContent-Type: ${mediaFile.mimeType || "application/octet-stream"}\r\n\r\n`,
    ),
  );
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const data = await graphFetch(`${config.phoneNumberId}/media`, config, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  });
  if (!data?.id) throw new Error("Meta media upload did not return an id.");
  return data.id;
}

async function downloadIncomingMedia(userId, descriptor, config) {
  if (!descriptor) return null;
  const info = await graphFetch(`${descriptor.id}`, config);
  if (!info?.url) return null;
  const res = await fetch(info.url, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to download Meta media: HTTP ${res.status}`);
  const buffer = await res.buffer();
  fs.mkdirSync(mediaDir, { recursive: true });
  const extension = (String(descriptor.mimeType).split("/")[1] || "bin").split(";")[0];
  const filename = `${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(mediaDir, filename), buffer);
  const mediaFile = await prisma.mediaFile.create({
    data: {
      userId,
      fileName: filename,
      originalName: descriptor.filename,
      mimeType: descriptor.mimeType,
      size: buffer.length,
      relativePath: `media/${filename}`,
    },
  });
  return mediaFile;
}

async function handleStatus(status) {
  if (!status?.id || !status?.status) return;
  const mapped = status.status === "read" ? "read" : status.status === "delivered" ? "delivered" : status.status === "sent" ? "sent" : null;
  if (!mapped) return;
  const message = await prisma.message.findFirst({ where: { externalMessageId: status.id } });
  if (!message) return;
  const existing = await prisma.messageStatus.findFirst({ where: { messageId: message.id, status: mapped } });
  if (!existing) await chatService.addMessageStatus(message.id, mapped);
}

async function handleIncomingMessage({ session, config, contact, message, io, userRoom, sessionManager }) {
  const sender = externalIdForWaId(message.from);
  const descriptor = mediaDescriptor(message);
  let mediaFile = null;
  if (descriptor) {
    mediaFile = await downloadIncomingMedia(session.userId, descriptor, config);
  }
  const body = descriptor?.caption || mapIncomingText(message);
  const type = descriptor?.type || "text";
  const incoming = await chatService.storeIncomingMessage({
    userId: session.userId,
    sessionId: session.id,
    sender,
    displayName: contact?.profile?.name || sender,
    body,
    type: ["image", "video", "audio", "document", "sticker"].includes(type) ? type : "text",
    mediaFileId: mediaFile?.id || null,
    externalMessageId: message.id || null,
  });

  if (io) {
    io.to(userRoom(session.userId)).emit("new_message", incoming.message);
    io.to(userRoom(session.userId)).emit("contact_list_update", incoming.chat);
  }

  try {
    await webhookService.notifyWebhook(session.userId, {
      chat: incoming.chat,
      message: incoming.message,
    });
  } catch (error) {
    console.error("[WhatsAppMeta] Webhook delivery failed:", error);
  }

  try {
    await crmAutoReplyService.maybeAutoReply({
      userId: session.userId,
      chat: incoming.chat,
      inboundMessage: incoming.message,
      io,
      sessionManager,
      userRoom,
    });
  } catch (error) {
    console.error("[WhatsAppMeta] CRM auto-reply failed:", error);
  }

  return incoming;
}

async function handleWebhookPayload(payload, { rawBody, signature, io, userRoom, sessionManager } = {}) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const results = [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      const resolved = await findSessionByPhoneNumberId(phoneNumberId);
      if (!resolved) continue;
      const { session, config } = resolved;
      if (!verifySignature(rawBody, config.appSecret, signature)) {
        throw new Error("Invalid Meta webhook signature.");
      }
      for (const status of value.statuses || []) {
        await handleStatus(status);
      }
      for (const message of value.messages || []) {
        const contact = (value.contacts || []).find((item) => item.wa_id === message.from);
        results.push(await handleIncomingMessage({ session, config, contact, message, io, userRoom, sessionManager }));
      }
    }
  }
  return results;
}

async function sendMessage(message) {
  const config = getSessionConfig(message.sessionId);
  if (!config?.phoneNumberId || !config?.accessToken) {
    throw new Error("WhatsApp Meta API config is missing for this session.");
  }
  const to = normalizeRecipient(message.receiver);
  if (!to) throw new Error("Invalid WhatsApp Meta recipient.");

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
  };

  if (message.mediaFile) {
    const mediaId = await uploadMedia(message.mediaFile, config);
    const type = message.type === "sticker" ? "sticker" : message.type;
    payload.type = type;
    payload[type] = { id: mediaId };
    if (message.body && ["image", "video", "document"].includes(type)) {
      payload[type].caption = message.body;
    }
  } else {
    payload.type = "text";
    payload.text = { preview_url: true, body: message.body || "" };
  }

  const data = await graphFetch(`${config.phoneNumberId}/messages`, config, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { externalMessageId: data?.messages?.[0]?.id || null };
}

module.exports = {
  deleteSessionConfig,
  externalIdForWaId,
  findSessionByPhoneNumberId,
  findVerifyToken,
  getSessionConfig,
  handleWebhookPayload,
  maskConfig,
  normalizeRecipient,
  sendMessage,
  setSessionConfig,
};
