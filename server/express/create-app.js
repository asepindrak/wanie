const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  authMiddleware,
  dashboardAuthMiddleware,
  isSqliteTimeoutError,
  retryOnSqliteTimeout,
  loginUser,
  registerUser,
  resetPassword,
  resetPasswordById,
} = require("../services/auth-service");
const apiKeyService = require("../services/api-key-service");
const chatService = require("../services/chat-service");
const assistantService = require("../services/assistant-service");
const sessionService = require("../services/session-service");
const webhookService = require("../services/webhook-service");
const outboundDeliveryService = require("../services/outbound-delivery-service");
const aiProviderService = require("../services/ai-provider-service");
const llmService = require("../services/llm-service");
const agentService = require("../services/agent-service");
const terminalService = require("../services/terminal-service");
const toolCredentialService = require("../services/tool-credential-service");
const authConfigService = require("../services/auth-config-service");
const userSettings = require("../services/user-settings");
const crmService = require("../services/crm-service");
const crmAutoReplyService = require("../services/crm-auto-reply-service");
const knowledgeService = require("../services/knowledge-service");
const TelegramConfigService = require("../services/telegram-config-service");
const TelegramService = require("../services/telegram-service");
const WhatsAppMetaService = require("../services/whatsapp-meta-service");
const { prisma } = require("../database/client");
const {
  createAgentReadme,
  createOpenApiDocument,
  createSwaggerHtml,
  packageName,
  packageVersion,
} = require("./openapi");
const { initializeDatabase } = require("../database/init");
const {
  mediaDir,
  knowledgeDir,
  storageDir,
  ensureRuntimeDirs,
} = require("../utils/paths");

function removeDirectoryContents(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  for (const entry of fs.readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, entry);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Failed to remove storage entry ${fullPath}:`, err.message);
    }
  }
}

function inferMessageType(file) {
  if (!file?.mimetype) {
    return "document";
  }

  if (file.mimetype === "image/webp") {
    return "sticker";
  }

  if (file.mimetype.startsWith("image/")) {
    return "image";
  }
  if (file.mimetype.startsWith("video/")) {
    return "video";
  }
  if (file.mimetype.startsWith("audio/")) {
    return "audio";
  }

  return "document";
}

function createUploader() {
  const storage = multer.diskStorage({
    destination: mediaDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  return multer({ storage });
}

function normalizeTelegramAdminIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || "")
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 10) return `${text.slice(0, 2)}...${text.slice(-2)}`;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch (err) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw err;
  }
}

function normalizeGeneratedWebhookConfig(value = {}) {
  const headers =
    value.headers && typeof value.headers === "object" && !Array.isArray(value.headers)
      ? value.headers
      : {};
  const method = String(value.method || "POST").trim().toUpperCase();
  const allowedMethods = new Set(["POST", "PUT", "PATCH", "DELETE", "GET"]);

  return {
    url: String(value.url || "").trim(),
    method: allowedMethods.has(method) ? method : "POST",
    headers: Object.entries(headers).reduce((acc, [key, headerValue]) => {
      const name = String(key || "").trim();
      if (!name) return acc;
      acc[name] = String(headerValue ?? "");
      return acc;
    }, {}),
    bodyTemplate:
      typeof value.bodyTemplate === "string"
        ? value.bodyTemplate
        : JSON.stringify(value.bodyTemplate || {}, null, 2),
    notes: String(value.notes || "").trim(),
  };
}

function createKnowledgeUploader() {
  const storage = multer.diskStorage({
    destination: knowledgeDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  return multer({ storage });
}

function getFilenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const basename = path.basename(parsed.pathname);
    return basename || "download";
  } catch (error) {
    return "download";
  }
}

function getExtensionFromMimeType(mimeType) {
  if (!mimeType) return "";
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "video/quicktime") return ".mov";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "audio/wav") return ".wav";
  if (normalized === "application/pdf") return ".pdf";
  if (normalized === "application/zip") return ".zip";
  return "";
}

async function downloadMediaUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download media from URL: ${response.status} ${response.statusText}`,
    );
  }

  const contentType =
    response.headers.get("content-type") || "application/octet-stream";
  const originalname = getFilenameFromUrl(url);
  let ext = path.extname(originalname);
  if (!ext) {
    ext = getExtensionFromMimeType(contentType) || ".bin";
  }

  const filename = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(mediaDir, filename);
  const buffer = Buffer.from(await response.arrayBuffer());

  fs.writeFileSync(filePath, buffer);

  return {
    path: filePath,
    filename,
    originalname,
    mimetype: contentType.split(";")[0].trim(),
    size: buffer.length,
  };
}

function withAsync(handler, statusCode = 500) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(error?.code === "P1008" ? 503 : statusCode).json({
        error:
          error?.code === "P1008"
            ? "Database is busy. Please try again."
            : error.message,
      });
    }
  };
}

async function deliverOutgoingApiMessage({
  userId,
  result,
  sessionManager,
  io,
}) {
  const message = result?.message;
  if (!message) return result;

  const deliveryJob = await outboundDeliveryService.enqueueMessage({
    userId,
    messageId: message.id,
    sessionManager,
    io,
  });
  result.deliveryJob = outboundDeliveryService.serializeJob(deliveryJob);

  if (deliveryJob?.status === "delivered") {
    message.statuses = [
      ...(message.statuses || []),
      { status: "delivered", createdAt: deliveryJob.deliveredAt || new Date() },
    ];
  }

  return result;
}

function emitChatResult(io, userId, result) {
  if (!io || !userId || !result) return;
  const room = `user:${userId}`;
  if (result.message) {
    io.to(room).emit("new_message", result.message);
  }
  if (result.chat) {
    io.to(room).emit("contact_list_update", result.chat);
  }
}

function createApp({ config, sessionManager }) {
  const app = express();
  // CORS middleware harus di paling atas
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-API-Key, X-Wanie-API-Key, X-OpenWA-API-Key, X-Client-Platform",
    );
    res.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    return next();
  });

  const upload = createUploader();
  const knowledgeUpload = createKnowledgeUploader();
  const requireAuth = authMiddleware(config);
  const requireDashboardAuth = dashboardAuthMiddleware(config);
  const openApiDocument = createOpenApiDocument(config);

  // Endpoint DELETE session harus di sini agar app dan requireAuth sudah terdefinisi
  app.delete("/api/sessions/:sessionId", requireAuth, async (req, res) => {
    try {
      try {
        await sessionManager.disconnectSession(req.user.id, req.params.sessionId);
      } catch (disconnectError) {
        if (disconnectError.message !== "Session not found.") {
          console.warn(
            `Failed to disconnect session before delete (${req.params.sessionId}):`,
            disconnectError.message,
          );
        }
      }

      const result = await sessionService.deleteSession(
        req.user.id,
        req.params.sessionId,
      );
      WhatsAppMetaService.deleteSessionConfig(req.params.sessionId);
      res.json({ ok: true, deleted: Boolean(result?.deleted) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.use(
    express.json({
      limit: "10mb",
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  app.use("/media", express.static(mediaDir));

  app.get("/api/whatsapp/meta/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && WhatsAppMetaService.findVerifyToken(token)) {
      return res.status(200).send(String(challenge || ""));
    }
    return res.sendStatus(403);
  });

  app.post(
    "/api/whatsapp/meta/webhook",
    withAsync(async (req, res) => {
      await WhatsAppMetaService.handleWebhookPayload(req.body || {}, {
        rawBody: req.rawBody,
        signature: req.headers["x-hub-signature-256"],
        io: req.app.get("io"),
        sessionManager,
        userRoom: (userId) => `user:${userId}`,
      });
      res.json({ ok: true });
    }, 400),
  );

  app.get("/docs", (req, res) => {
    res.type("html").send(createSwaggerHtml());
  });

  app.get("/docs/json", (req, res) => {
    res.json(openApiDocument);
  });

  app.get("/docs/readme", (req, res) => {
    (async () => {
      try {
        // If the requester presents a dashboard JWT, create a convenience API key
        // so the README can include a usable secret for agent workflows.
        const header = req.headers.authorization || "";
        const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
        let secret = null;

        if (bearer) {
          try {
            const { getUserFromToken } = require("../services/auth-service");
            const user = await getUserFromToken(bearer, config);
            if (user) {
              // create a short-lived API key for agent onboarding
              const apiKeyName = `agent-readme-${Date.now()}`;
              try {
                const result = await apiKeyService.createApiKey(user.id, {
                  name: apiKeyName,
                });
                secret = result.secret;
              } catch (e) {
                // fall back silently if creation fails
                console.warn(
                  "Failed to create agent readme API key:",
                  e.message || e,
                );
              }
            }
          } catch (e) {
            // ignore token parse errors
          }
        }

        res.type("text/markdown").send(createAgentReadme(config, secret));
      } catch (err) {
        res.type("text/markdown").send(createAgentReadme(config));
      }
    })();
  });

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: packageName,
      version: packageVersion,
    });
  });

  app.get("/version", (req, res) => {
    res.json({
      name: packageName,
      version: packageVersion,
    });
  });

  app.get("/api/health", async (req, res) => {
    res.json({
      ok: true,
      service: packageName,
      version: packageVersion,
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const userCount = await prisma.user.count();
      const authConfig = authConfigService.getConfig();

      if (userCount > 0 && !authConfig.allowRegistration) {
        return res.status(403).json({
          error: "Registration is currently disabled.",
        });
      }

      const result = await registerUser({
        ...req.body,
        config,
      });

      await chatService.ensureWelcomeWorkspace(result.user.id);

      res.status(201).json(result);
    } catch (error) {
      res.status(isSqliteTimeoutError(error) ? 503 : 400).json({
        error: isSqliteTimeoutError(error)
          ? "Database is busy. Please try again."
          : error.message,
      });
    }
  });

  app.get("/api/auth/config", async (req, res) => {
    try {
      const userCount = await prisma.user.count();
      const authConfig = authConfigService.getConfig();
      const allowRegistration =
        userCount === 0 ? true : !!authConfig.allowRegistration;
      res.json({ allowRegistration });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post(
    "/api/auth/config",
    requireAuth,
    withAsync(async (req, res) => {
      try {
        const allowRegistration = req.body?.allowRegistration;
        if (typeof allowRegistration !== "boolean") {
          throw new Error(
            "allowRegistration is required and must be a boolean.",
          );
        }

        const authConfig = authConfigService.saveConfig({
          allowRegistration,
        });
        res.json({ ok: true, allowRegistration: authConfig.allowRegistration });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    }),
  );

  app.post("/api/auth/login", async (req, res) => {
    try {
      const result = await loginUser({
        ...req.body,
        config,
      });

      await chatService.ensureWelcomeWorkspace(result.user.id);

      res.json(result);
    } catch (error) {
      res.status(isSqliteTimeoutError(error) ? 503 : 400).json({
        error: isSqliteTimeoutError(error)
          ? "Database is busy. Please try again."
          : error.message,
      });
    }
  });

  app.post("/api/auth/reset-password-request", async (req, res) => {
    try {
      const { email, secret } = req.body || {};
      if (!email || !secret) {
        throw new Error("Email and secret are required.");
      }

      if (secret !== config.jwtSecret) {
        return res.status(401).json({ error: "Invalid Wanie secret." });
      }

      const normalizedEmail = String(email || "")
        .trim()
        .toLowerCase();
      const user = await retryOnSqliteTimeout(() =>
        prisma.user.findUnique({ where: { email: normalizedEmail } }),
      );

      if (!user) {
        throw new Error("User not found.");
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(isSqliteTimeoutError(error) ? 503 : 400).json({
        error: isSqliteTimeoutError(error)
          ? "Database is busy. Please try again."
          : error.message,
      });
    }
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { email, password, secret } = req.body || {};
      if (!email || !password || !secret) {
        throw new Error("Email, password, and secret are required.");
      }

      if (secret !== config.jwtSecret) {
        return res.status(401).json({ error: "Invalid Wanie secret." });
      }

      const result = await resetPassword({ email, password });
      res.json({ ok: true, user: result });
    } catch (error) {
      res.status(isSqliteTimeoutError(error) ? 503 : 400).json({
        error: isSqliteTimeoutError(error)
          ? "Database is busy. Please try again."
          : error.message,
      });
    }
  });

  app.get(
    "/api/auth/me",
    requireAuth,
    withAsync(async (req, res) => {
      res.json({ user: req.user });
    }),
  );

  app.post(
    "/api/settings/reset-password",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const { password } = req.body || {};
      if (!password) {
        throw new Error("Password is required.");
      }
      const user = await resetPasswordById({
        userId: req.user.id,
        password,
      });
      res.json({ ok: true, user });
    }),
  );

  app.post(
    "/api/settings/reset-all",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const { confirm } = req.body || {};
      if (confirm !== "YES") {
        throw new Error("Confirm value must be YES to reset all data.");
      }

      try {
        await TelegramService.stopAll();
      } catch (err) {
        console.warn(
          "Failed to stop Telegram bots during reset-all:",
          err.message,
        );
      }

      try {
        await sessionManager.stopAll();
      } catch (err) {
        console.warn(
          "Failed to stop WhatsApp sessions during reset-all:",
          err.message,
        );
      }

      try {
        await prisma.$disconnect();
      } catch (err) {
        console.warn(
          "Failed to disconnect Prisma during reset-all:",
          err.message,
        );
      }

      if (fs.existsSync(storageDir)) {
        removeDirectoryContents(storageDir);
      }
      ensureRuntimeDirs();

      await initializeDatabase();

      res.json({
        ok: true,
        message:
          "All data has been reset. You have been logged out and can now register again.",
      });
    }),
  );

  app.get(
    "/api/api-keys",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const apiKeys = await apiKeyService.listApiKeys(req.user.id);
      res.json({ apiKeys });
    }),
  );

  app.post("/api/api-keys", requireDashboardAuth, async (req, res) => {
    try {
      const result = await apiKeyService.createApiKey(req.user.id, req.body);
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete(
    "/api/api-keys/:apiKeyId",
    requireDashboardAuth,
    async (req, res) => {
      try {
        const result = await apiKeyService.revokeApiKey(
          req.user.id,
          req.params.apiKeyId,
        );
        res.json(result);
      } catch (error) {
        res.status(404).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/webhook",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const cfg = webhookService.getWebhook(req.user.id);
      res.json({ webhook: cfg });
    }),
  );

  app.post(
    "/api/webhook",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const { url, apiKey, enabled, method, headers, bodyTemplate } =
        req.body || {};
      if (!url) {
        return res.status(400).json({ error: "url is required" });
      }

      const cfg = webhookService.setWebhook(req.user.id, {
        url,
        apiKey,
        enabled,
        method,
        headers,
        bodyTemplate,
      });
      res.json({ ok: true, webhook: cfg });
    }, 400),
  );

  app.post(
    "/api/webhook/generate-config",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const prompt = String(req.body?.prompt || "").trim();
      if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
      }

      const instruction = `You generate Wanie outgoing webhook configuration for an external application.

Return strict JSON only, no markdown, with this shape:
{
  "url": "https://external-app.example/webhook",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer token-or-placeholder",
    "x-api-key": "api-key-or-placeholder"
  },
  "bodyTemplate": "{\\"chatId\\":\\"{{chat.id}}\\",\\"messageId\\":\\"{{message.id}}\\",\\"text\\":\\"{{message.body}}\\",\\"payload\\":{{payload}}}",
  "notes": "Short setup note"
}

Rules:
- Infer the URL, HTTP method, auth headers, and request body from the user's example.
- Keep secret values as placeholders when the user does not provide exact values.
- Use Wanie placeholders in bodyTemplate: {{payload}}, {{chat.id}}, {{chat.title}}, {{chat.transportType}}, {{chat.contact.externalId}}, {{message.id}}, {{message.body}}, {{message.type}}, {{message.mediaFile.url}}.
- bodyTemplate must be a string. It may contain JSON with placeholders.
- Prefer JSON body unless the external example clearly requires another format.`;

      const result = await llmService.generate(req.user.id, {
        temperature: 0.1,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: prompt },
        ],
      });
      const parsed = extractJsonObject(result?.text || result);
      const config = normalizeGeneratedWebhookConfig(parsed || {});
      if (!config.url) {
        return res
          .status(400)
          .json({ error: "AI did not return a webhook URL." });
      }

      res.json({ config });
    }, 400),
  );

  app.delete(
    "/api/webhook",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      webhookService.deleteWebhook(req.user.id);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/webhook/test",
    requireAuth,
    withAsync(async (req, res) => {
      const result = await webhookService.testWebhook(req.user.id);
      res.json({
        ok: Boolean(result?.ok),
        delivery: result?.log || null,
        error: result?.error || null,
      });
    }, 400),
  );

  app.get(
    "/api/webhook/deliveries",
    requireAuth,
    withAsync(async (req, res) => {
      const deliveries = await webhookService.listDeliveries(req.user.id, {
        status: req.query.status,
        chatId: req.query.chatId,
        limit: req.query.limit,
      });
      res.json({ deliveries });
    }),
  );

  app.post(
    "/api/webhook/deliveries/:deliveryId/retry",
    requireAuth,
    withAsync(async (req, res) => {
      const result = await webhookService.retryDelivery(
        req.user.id,
        req.params.deliveryId,
      );
      res.json(result);
    }, 400),
  );

  app.get(
    "/api/outbound-deliveries",
    requireAuth,
    withAsync(async (req, res) => {
      const deliveries = await outboundDeliveryService.listJobs(req.user.id, {
        status: req.query.status,
        chatId: req.query.chatId,
        limit: req.query.limit,
      });
      res.json({
        deliveries: deliveries.map(outboundDeliveryService.serializeJob),
      });
    }),
  );

  app.post(
    "/api/outbound-deliveries/:deliveryId/retry",
    requireAuth,
    withAsync(async (req, res) => {
      const delivery = await outboundDeliveryService.retryJob(
        req.user.id,
        req.params.deliveryId,
        {
          sessionManager,
          io: req.app.get("io"),
        },
      );
      res.json({ delivery: outboundDeliveryService.serializeJob(delivery) });
    }, 400),
  );

  app.post(
    "/api/outbound-deliveries/:deliveryId/cancel",
    requireAuth,
    withAsync(async (req, res) => {
      const delivery = await outboundDeliveryService.cancelJob(
        req.user.id,
        req.params.deliveryId,
        {
          io: req.app.get("io"),
        },
      );
      res.json({ delivery: outboundDeliveryService.serializeJob(delivery) });
    }, 400),
  );

  app.get(
    "/api/telegram/config",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const config = TelegramConfigService.getConfig(req.user.id) || {};
      res.json({
        config: {
          adminTelegramIds: Array.isArray(config.adminTelegramIds)
            ? config.adminTelegramIds.map((item) => String(item))
            : [],
          aiReplyEnabled: config.aiReplyEnabled !== false,
        },
      });
    }),
  );

  app.post(
    "/api/telegram/config",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const adminTelegramIds = normalizeTelegramAdminIds(
        req.body?.adminTelegramIds,
      );
      const config = TelegramConfigService.saveConfig(req.user.id, {
        adminTelegramIds,
        aiReplyEnabled: req.body?.aiReplyEnabled !== false,
      });

      res.json({
        ok: true,
        config: {
          adminTelegramIds: config.adminTelegramIds,
          aiReplyEnabled: config.aiReplyEnabled !== false,
        },
      });
    }),
  );

  app.get(
    "/api/telegram/bots",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const credential = await toolCredentialService.getCredentialForUser(
        req.user.id,
        "telegram_bot",
      );
      const status = TelegramService.getBotStatus(req.user.id);
      const bots =
        credential || status.running
          ? [
              {
                id: "telegram_bot",
                name: status.username ? `@${status.username}` : "Telegram Bot",
                username: status.username,
                botId: status.id,
                configured: Boolean(credential?.apiKey),
                running: Boolean(status.running),
                tokenPreview: credential?.apiKey
                  ? maskSecret(credential.apiKey)
                  : "",
                addedAt: credential?.addedAt || null,
              },
            ]
          : [];

      res.json({ bots });
    }),
  );

  app.delete(
    "/api/telegram/bots/:botId",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      if (req.params.botId !== "telegram_bot") {
        return res.status(404).json({ error: "Telegram bot not found." });
      }

      await TelegramService.stopBot(req.user.id);
      try {
        await toolCredentialService.removeCredentialForUser(
          req.user.id,
          "telegram_bot",
        );
      } catch (error) {
        if (error.message !== "credential not found") {
          throw error;
        }
      }

      res.json({ ok: true });
    }, 400),
  );

  // AI Provider management (dashboard-only)
  app.get(
    "/api/ai-providers",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const providers = await aiProviderService.listProviders(req.user.id);
      res.json({ providers });
    }),
  );

  app.post(
    "/api/ai-providers",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const { provider, name, config } = req.body || {};
      const created = await aiProviderService.createProvider(req.user.id, {
        provider,
        name,
        config,
      });
      res.status(201).json({ provider: created });
    }),
  );

  app.get(
    "/api/ai-providers/:providerId",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const provider = await aiProviderService.getProvider(
        req.user.id,
        req.params.providerId,
      );
      if (!provider) return res.status(404).json({ error: "Not found" });
      res.json({ provider });
    }),
  );

  app.put(
    "/api/ai-providers/:providerId",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const updated = await aiProviderService.updateProvider(
        req.user.id,
        req.params.providerId,
        req.body || {},
      );
      res.json({ provider: updated });
    }),
  );

  app.delete(
    "/api/ai-providers/:providerId",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      await aiProviderService.deleteProvider(
        req.user.id,
        req.params.providerId,
      );
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/ai-providers/:providerId/models",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const models = await aiProviderService.fetchModels(
        req.user.id,
        req.params.providerId,
      );
      res.json({ models });
    }),
  );

  // Assistant profile (dashboard)
  app.get(
    "/api/assistant",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const assistant = await assistantService.getAssistant(req.user.id);
      res.json({ assistant });
    }),
  );

  // Create a new Assistant conversation (fresh chat)
  app.post(
    "/api/assistant/sessions",
    requireAuth,
    withAsync(async (req, res) => {
      const title = req.body?.title;
      const chat = await chatService.createAssistantConversation(req.user.id, {
        title,
      });
      res.status(201).json({ chat });
    }),
  );

  // Delete an Assistant conversation (only non-default assistant instances)
  app.delete(
    "/api/assistant/sessions/:chatId",
    requireAuth,
    withAsync(async (req, res) => {
      try {
        await chatService.deleteAssistantConversation(
          req.user.id,
          req.params.chatId,
        );
        res.json({ ok: true });
      } catch (error) {
        res.status(error?.code === "P1008" ? 503 : 400).json({
          error: error?.message,
        });
      }
    }),
  );

  app.put(
    "/api/assistant",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const { displayName, avatarUrl, persona } = req.body || {};
      const assistant = await assistantService.updateAssistant(req.user.id, {
        displayName,
        avatarUrl,
        persona,
      });
      res.json({ assistant });
    }),
  );

  // Agent tools: read & update TOOLS.md
  app.get(
    "/api/agent/tools",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const content = await agentService.readToolsFile();
      res.json({ content });
    }),
  );

  app.put(
    "/api/agent/tools",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const { action, content } = req.body || {};
      await agentService.updateToolsFile({
        action: action || "append",
        content: content || "",
      });
      res.json({ ok: true });
    }),
  );

  // Register an external tool manifest (validate + append + registry)
  app.post(
    "/api/agent/register-tool",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const manifest = req.body?.manifest || req.body || {};
      const overwrite = Boolean(req.body?.overwrite);
      const result = await agentService.registerExternalTool(
        req.user.id,
        manifest,
        { overwrite },
      );
      // If caller provided apiKey/headerName in request body, persist credential for the registering user
      try {
        const apiKey = req.body?.apiKey || null;
        const headerName = req.body?.headerName || "Authorization";
        if (apiKey && result && result.tool && result.tool.id) {
          await toolCredentialService.saveCredential(
            req.user.id,
            result.tool.id,
            { apiKey, headerName },
          );
          result.credentialSaved = true;
        }
      } catch (e) {
        // don't fail registration on credential storage error; annotate result
        result.credentialSaved = false;
        result.credentialError = e && e.message ? e.message : String(e);
      }
      res.json(result);
    }),
  );

  // Register a tool by fetching a manifest from a URL (supports optional API key header)
  app.post(
    "/api/agent/register-tool-url",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const { url, apiKey, headerName, overwrite } = req.body || {};
      if (!url) return res.status(400).json({ error: "url is required" });
      const result = await agentService.fetchAndRegisterTool(req.user.id, {
        url,
        apiKey,
        headerName,
        overwrite,
      });
      res.json(result);
    }),
  );

  // Credential management for registered tools (per-user)
  app.post(
    "/api/agent/tools/:id/credential",
    requireAuth,
    withAsync(async (req, res) => {
      const toolId = req.params.id;
      const { apiKey, headerName } = req.body || {};
      if (!apiKey) return res.status(400).json({ error: "apiKey is required" });
      try {
        const result = await toolCredentialService.saveCredential(
          req.user.id,
          toolId,
          { apiKey, headerName },
        );
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  app.get(
    "/api/agent/tools/:id/credential",
    requireAuth,
    withAsync(async (req, res) => {
      const toolId = req.params.id;
      const cred = await toolCredentialService.getCredentialForUser(
        req.user.id,
        toolId,
      );
      res.json({
        ok: true,
        hasCredential: !!cred,
        addedAt: cred ? cred.addedAt : null,
      });
    }),
  );

  app.delete(
    "/api/agent/tools/:id/credential",
    requireAuth,
    withAsync(async (req, res) => {
      const toolId = req.params.id;
      try {
        const result = await toolCredentialService.removeCredentialForUser(
          req.user.id,
          toolId,
        );
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // Invoke a registered tool by id (authenticated)
  app.post(
    "/api/agent/invoke-tool/:id",
    requireAuth,
    withAsync(async (req, res) => {
      const id = req.params.id;
      const body = req.body || {};
      try {
        const result = await agentService.invokeRegisteredTool(
          req.user.id,
          id,
          body,
          { config },
        );
        res.json({ ok: true, result });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }),
  );

  // LLM generation endpoints - use configured providers
  app.post(
    "/api/ai/generate",
    requireAuth,
    withAsync(async (req, res) => {
      const params = req.body || {};
      const result = await llmService.generate(req.user.id, params);
      res.json({ result });
    }),
  );

  app.post(
    "/api/ai-providers/:providerId/generate",
    requireAuth,
    withAsync(async (req, res) => {
      const params = { ...(req.body || {}), providerId: req.params.providerId };
      const result = await llmService.generate(req.user.id, params);
      res.json({ result });
    }),
  );

  app.get(
    "/api/crm/settings",
    requireAuth,
    withAsync(async (req, res) => {
      const settings = await crmService.getSettings(req.user.id);
      res.json({ settings });
    }),
  );

  app.post(
    "/api/crm/settings",
    requireAuth,
    withAsync(async (req, res) => {
      const settings = await crmService.updateSettings(req.user.id, req.body);
      res.json({ ok: true, settings });
    }, 400),
  );

  app.post(
    "/api/crm/persona/generate",
    requireAuth,
    withAsync(async (req, res) => {
      const input = String(req.body?.input || "").trim();
      if (!input) return res.status(400).json({ error: "input is required." });

      const result = await llmService.generate(req.user.id, {
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content: [
              "Create a concise CRM auto-reply persona and brand voice instruction in Indonesian.",
              "The result will be inserted into a system prompt for WhatsApp customer support.",
              "Return only the persona instruction, no title, no markdown.",
              "Include tone, greeting style, boundaries, and what the AI must not invent.",
              "",
              `User input: ${input}`,
            ].join("\n"),
          },
        ],
      });

      res.json({ persona: String(result?.text || "").trim() });
    }, 400),
  );

  app.post(
    "/api/crm/sessions/:sessionId/settings",
    requireAuth,
    withAsync(async (req, res) => {
      await crmService.setSessionMode(
        req.user.id,
        req.params.sessionId,
        req.body?.mode || "inherit",
      );
      const settings = await crmService.getSettings(req.user.id);
      res.json({ ok: true, settings });
    }, 400),
  );

  app.post(
    "/api/crm/chats/:chatId/settings",
    requireAuth,
    withAsync(async (req, res) => {
      await crmService.setChatMode(
        req.user.id,
        req.params.chatId,
        req.body?.mode || "inherit",
      );
      const settings = await crmService.getSettings(req.user.id);
      res.json({ ok: true, settings });
    }, 400),
  );

  app.post(
    "/api/crm/chats/:chatId/resume-auto-reply",
    requireAuth,
    withAsync(async (req, res) => {
      await crmService.resumeAutoReplyForChat(req.user.id, req.params.chatId);
      const settings = await crmService.getSettings(req.user.id);
      res.json({ ok: true, settings });
    }, 400),
  );

  app.post(
    "/api/crm/chats/:chatId/draft",
    requireAuth,
    withAsync(async (req, res) => {
      const result = await crmAutoReplyService.generateDraft(
        req.user.id,
        req.params.chatId,
      );
      await crmService.createAutomationLog(req.user.id, {
        chatId: req.params.chatId,
        mode: "draft",
        action: "draft_generated",
        draft: result.draft,
        sources: result.sources || [],
      });
      res.json(result);
    }, 400),
  );

  app.get(
    "/api/crm/logs",
    requireAuth,
    withAsync(async (req, res) => {
      const logs = await crmService.listAutomationLogs(req.user.id, {
        chatId: req.query.chatId,
        limit: req.query.limit,
      });
      res.json({ logs });
    }),
  );

  app.get(
    "/api/knowledge/documents",
    requireAuth,
    withAsync(async (req, res) => {
      const documents = await knowledgeService.listDocuments(req.user.id);
      res.json({ documents });
    }),
  );

  app.post(
    "/api/knowledge/search",
    requireAuth,
    withAsync(async (req, res) => {
      const query = String(req.body?.query || "").trim();
      if (!query) return res.status(400).json({ error: "query is required." });
      const results = await knowledgeService.searchChunks(req.user.id, query, {
        limit: req.body?.limit,
      });
      res.json({ results });
    }, 400),
  );

  app.post(
    "/api/knowledge/test-chat",
    requireAuth,
    withAsync(async (req, res) => {
      const question = String(req.body?.question || "").trim();
      if (!question) {
        return res.status(400).json({ error: "question is required." });
      }
      const result = await crmAutoReplyService.testKnowledgeChat(
        req.user.id,
        question,
      );
      res.json(result);
    }, 400),
  );

  app.post(
    "/api/knowledge/documents",
    requireAuth,
    knowledgeUpload.fields([
      { name: "file", maxCount: 50 },
      { name: "files", maxCount: 50 },
    ]),
    withAsync(async (req, res) => {
      const files = [
        ...(req.files?.file || []),
        ...(req.files?.files || []),
      ];
      if (!files.length) {
        return res.status(400).json({ error: "file is required." });
      }

      const documents = await knowledgeService.createDocumentsFromUploads(
        req.user.id,
        files,
      );
      res.status(201).json({
        document: documents[0] || null,
        documents,
      });
    }, 400),
  );

  app.get(
    "/api/knowledge/documents/:documentId/chunks",
    requireAuth,
    withAsync(async (req, res) => {
      const result = await knowledgeService.getDocumentChunks(
        req.user.id,
        req.params.documentId,
      );
      res.json(result);
    }, 404),
  );

  app.get(
    "/api/knowledge/documents/:documentId/download",
    requireAuth,
    withAsync(async (req, res) => {
      const download = await knowledgeService.getDocumentDownload(
        req.user.id,
        req.params.documentId,
      );
      res.type(download.mimeType);
      res.download(download.filePath, download.fileName);
    }, 404),
  );

  app.delete(
    "/api/knowledge/documents/:documentId",
    requireAuth,
    withAsync(async (req, res) => {
      const result = await knowledgeService.deleteDocument(
        req.user.id,
        req.params.documentId,
      );
      res.json(result);
    }, 400),
  );

  app.post(
    "/api/knowledge/documents/:documentId/reindex",
    requireAuth,
    withAsync(async (req, res) => {
      const document = await knowledgeService.reindexDocument(
        req.user.id,
        req.params.documentId,
      );
      res.json({ ok: true, document });
    }, 400),
  );

  app.get("/api/bootstrap", requireAuth, async (req, res) => {
    try {
      await chatService.ensureWelcomeWorkspace(req.user.id);
      const sessions = await sessionService.listUserSessions(req.user.id);
      const chats = await chatService.listChats(req.user.id);
      const activeChatId = chats[0]?.id || null;
      const messageResult = activeChatId
        ? await chatService.listMessages(req.user.id, activeChatId)
        : { messages: [], hasMore: false, nextBefore: null };

      // Load persistent user settings and include in bootstrap payload
      let settings = {};
      try {
        const autoApprove = await userSettings.getSetting(
          req.user.id,
          "autoApproveAllTerminalCommands",
        );
        const defaultAiProviderId = await userSettings.getSetting(
          req.user.id,
          "defaultAiProviderId",
        );
        const defaultAiModel = await userSettings.getSetting(
          req.user.id,
          "defaultAiModel",
        );

        settings.autoApproveAllTerminalCommands = !!autoApprove;
        settings.defaultAiProviderId = defaultAiProviderId || null;
        settings.defaultAiModel = defaultAiModel || null;
      } catch (e) {
        settings = {};
      }

      const clientPlatform = req.headers["x-client-platform"] || null;

      res.json({
        user: req.user,
        sessions,
        chats,
        activeChatId,
        messages: messageResult.messages,
        hasMoreMessages: messageResult.hasMore,
        nextBefore: messageResult.nextBefore,
        settings,
        clientPlatform,
      });
    } catch (error) {
      res.status(error?.code === "P1008" ? 503 : 500).json({
        error:
          error?.code === "P1008"
            ? "Database is busy. Please try again."
            : error.message,
      });
    }
  });

  app.get(
    "/api/sessions",
    requireAuth,
    withAsync(async (req, res) => {
      const sessions = await sessionService.listUserSessions(req.user.id);
      res.json({ sessions });
    }),
  );

  app.post("/api/sessions", requireAuth, async (req, res) => {
    try {
      if (req.body?.transportType === "whatsapp_cloud") {
        const { phoneNumberId, accessToken, verifyToken } = req.body || {};
        if (!phoneNumberId || !accessToken || !verifyToken) {
          throw new Error(
            "phoneNumberId, accessToken, and verifyToken are required for WhatsApp Meta API sessions.",
          );
        }
      }
      const session = await sessionService.createUserSession(
        req.user.id,
        req.body,
      );
      if (session.transportType === "whatsapp_cloud") {
        const {
          phoneNumberId,
          businessAccountId,
          accessToken,
          verifyToken,
          appSecret,
        } = req.body || {};
        WhatsAppMetaService.setSessionConfig(session.id, {
          phoneNumberId,
          businessAccountId,
          accessToken,
          verifyToken,
          appSecret,
        });
      }
      // Only create companion chat if requested or not explicitly disabled
      if (
        req.body.createCompanionChat !== false &&
        session.transportType !== "whatsapp_cloud"
      ) {
        await chatService.createSessionCompanionChat(req.user.id, session);
      }
      res.status(201).json({ session });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(
    "/api/sessions/:sessionId/connect",
    requireAuth,
    async (req, res) => {
      try {
        await sessionManager.connectSession(req.user.id, req.params.sessionId, {
          force: true,
        });
        const session = await sessionService.getSessionById(
          req.user.id,
          req.params.sessionId,
        );
        res.json({ session });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    },
  );

  // Client confirms they scanned the QR shown in chat. This will (re)attempt connect.
  app.post(
    "/api/sessions/:sessionId/confirm-scan",
    requireAuth,
    async (req, res) => {
      try {
        await sessionManager.connectSession(req.user.id, req.params.sessionId, {
          force: false,
        });
        const session = await sessionService.getSessionById(
          req.user.id,
          req.params.sessionId,
        );
        res.json({ session });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    },
  );

  // Terminal execution (auto/manual approval)
  app.post(
    "/api/terminal/execute",
    requireAuth,
    withAsync(async (req, res) => {
      const { command, approvalMode, timeout } = req.body || {};
      if (!command)
        return res.status(400).json({ error: "command is required" });
      const io = req.app.get("io");
      // If user has enabled server-side auto-approve, prefer 'auto' when
      // approvalMode isn't explicitly set to 'manual'.
      let effectiveApprovalMode = approvalMode;
      try {
        const pref = await userSettings.getSetting(
          req.user.id,
          "autoApproveAllTerminalCommands",
        );
        if (!effectiveApprovalMode && pref) effectiveApprovalMode = "auto";
      } catch (e) {
        // ignore
      }

      const result = await terminalService.requestExecution(
        req.user.id,
        { command, approvalMode: effectiveApprovalMode, timeout },
        io,
      );
      res.json(result);
    }),
  );

  // Terminal history for the authenticated user
  app.get(
    "/api/terminal/history",
    requireAuth,
    withAsync(async (req, res) => {
      const limit = req.query.limit || 50;
      const items = await terminalService.listHistory(req.user.id, limit);
      res.json({ items });
    }),
  );

  app.get(
    "/api/terminal/:id",
    requireAuth,
    withAsync(async (req, res) => {
      const id = req.params.id;
      const rec = await terminalService.getRequestById(id);
      if (!rec) return res.status(404).json({ error: "Not found" });
      if (rec.userId !== req.user.id)
        return res.status(403).json({ error: "Forbidden" });
      res.json({ item: rec });
    }),
  );

  // Rerun a previous command: creates a new execution request using the same command
  app.post(
    "/api/terminal/:id/rerun",
    requireAuth,
    withAsync(async (req, res) => {
      const id = req.params.id;
      const rec = await terminalService.getRequestById(id);
      if (!rec) return res.status(404).json({ error: "Not found" });
      if (rec.userId !== req.user.id)
        return res.status(403).json({ error: "Forbidden" });

      const { approvalMode, timeout } = req.body || {};
      const io = req.app.get("io");

      const result = await terminalService.requestExecution(
        req.user.id,
        {
          command: rec.command,
          approvalMode: approvalMode || rec.approvalMode || "manual",
          timeout: timeout || undefined,
        },
        io,
      );

      res.json(result);
    }),
  );

  app.get(
    "/api/terminal/pending",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const items = await terminalService.listPendingRequests(req.user.id);
      res.json({ items });
    }),
  );

  app.post(
    "/api/terminal/:id/approve",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const id = req.params.id;
      const io = req.app.get("io");
      const result = await terminalService.approveRequest(
        req.user.id,
        id,
        true,
        io,
      );
      res.json({ ok: true, result });
    }),
  );

  app.post(
    "/api/terminal/:id/deny",
    requireDashboardAuth,
    withAsync(async (req, res) => {
      const id = req.params.id;
      const io = req.app.get("io");
      const result = await terminalService.approveRequest(
        req.user.id,
        id,
        false,
        io,
      );
      res.json({ ok: true, result });
    }),
  );

  // Update user settings (e.g. terminal auto-approve preference)
  app.post(
    "/api/user/settings",
    requireAuth,
    withAsync(async (req, res) => {
      const {
        autoApproveAllTerminalCommands,
        defaultAiProviderId,
        defaultAiModel,
      } = req.body || {};
      try {
        const payload = {};
        if (autoApproveAllTerminalCommands !== undefined)
          payload.autoApproveAllTerminalCommands =
            !!autoApproveAllTerminalCommands;
        if (defaultAiProviderId !== undefined)
          payload.defaultAiProviderId = defaultAiProviderId || null;
        if (defaultAiModel !== undefined)
          payload.defaultAiModel = defaultAiModel || null;

        await userSettings.setBulk(req.user.id, payload);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }),
  );

  app.post(
    "/api/sessions/:sessionId/disconnect",
    requireAuth,
    async (req, res) => {
      try {
        await sessionManager.disconnectSession(
          req.user.id,
          req.params.sessionId,
        );
        const session = await sessionService.getSessionById(
          req.user.id,
          req.params.sessionId,
        );
        res.json({ session });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/chats",
    requireAuth,
    withAsync(async (req, res) => {
      const chats = await chatService.listChats(
        req.user.id,
        req.query.sessionId || undefined,
        req.query.q || "",
      );
      res.json({ chats });
    }),
  );

  app.post("/api/chats/:chatId/pin", requireAuth, async (req, res) => {
    try {
      const chat = await chatService.pinChat(req.user.id, req.params.chatId);
      res.json({ chat });
    } catch (error) {
      res.status(error?.code === "P1008" ? 503 : 400).json({
        error: error.message,
      });
    }
  });

  app.post("/api/chats/:chatId/unpin", requireAuth, async (req, res) => {
    try {
      const chat = await chatService.unpinChat(req.user.id, req.params.chatId);
      res.json({ chat });
    } catch (error) {
      res.status(error?.code === "P1008" ? 503 : 400).json({
        error: error.message,
      });
    }
  });

  app.delete(
    "/api/chats/:chatId",
    requireAuth,
    withAsync(async (req, res) => {
      try {
        await chatService.deleteChat(req.user.id, req.params.chatId);
        res.json({ ok: true });
      } catch (error) {
        res.status(error?.code === "P1008" ? 503 : 400).json({
          error: error?.message,
        });
      }
    }),
  );

  app.get(
    "/api/contacts",
    requireAuth,
    withAsync(async (req, res) => {
      const contacts = await chatService.listContacts(
        req.user.id,
        req.query.sessionId || undefined,
        req.query.q || "",
      );
      res.json({ contacts });
    }),
  );

  app.post("/api/contacts/:contactId/open", requireAuth, async (req, res) => {
    try {
      const chat = await chatService.openChatForContact(
        req.user.id,
        req.params.contactId,
      );
      res.json({ chat });
    } catch (error) {
      res.status(error?.code === "P1008" ? 503 : 400).json({
        error:
          error?.code === "P1008"
            ? "Database is busy. Please try again."
            : error.message,
      });
    }
  });

  app.post("/api/messages/send", requireAuth, async (req, res) => {
    try {
      const {
        chatId,
        phoneNumber,
        sessionId: requestedSessionId,
        body,
        type = "text",
        mediaFileId = null,
        mediaUrl = null,
        replyToId = null,
        displayName,
      } = req.body || {};

      if (!chatId && !phoneNumber) {
        throw new Error("chatId or phoneNumber is required.");
      }

      if (!requestedSessionId && !chatId) {
        throw new Error("sessionId is required.");
      }

      if (type === "text") {
        if (mediaUrl) {
          throw new Error("mediaUrl is only allowed for media message types.");
        }
        if (mediaFileId) {
          throw new Error(
            "mediaFileId is only allowed for media message types.",
          );
        }
        if (!body) {
          throw new Error("body is required for text messages.");
        }
      }

      const mediaTypes = ["image", "video", "audio", "document", "sticker"];
      const isMediaType = mediaTypes.includes(type);
      if (isMediaType && !mediaFileId && !mediaUrl) {
        throw new Error(
          "mediaFileId or mediaUrl is required for media messages.",
        );
      }

      if (mediaUrl && typeof mediaUrl === "string") {
        try {
          new URL(mediaUrl);
        } catch (error) {
          throw new Error("mediaUrl must be a valid URL.");
        }
      }

      let targetChat;
      let chosenSessionId = requestedSessionId;
      let effectiveType = type;
      let effectiveMediaFileId = mediaFileId;

      if (mediaUrl && !effectiveMediaFileId) {
        const downloadedFile = await downloadMediaUrl(mediaUrl);
        const uploadedMedia = await chatService.createMediaFile(
          req.user.id,
          downloadedFile,
        );
        effectiveMediaFileId = uploadedMedia.id;
        effectiveType = inferMessageType(downloadedFile);
      }

      if (chatId) {
        const existingChat = await chatService.getChatWithContact(
          req.user.id,
          chatId,
        );
        if (!existingChat) {
          throw new Error("Chat not found.");
        }
        if (
          existingChat.sessionId &&
          requestedSessionId &&
          existingChat.sessionId !== requestedSessionId
        ) {
          throw new Error("sessionId does not match the chat's sessionId.");
        }
        if (existingChat.sessionId) {
          chosenSessionId = existingChat.sessionId;
        }
        targetChat = existingChat;
      } else {
        if (!chosenSessionId) {
          const sessions = await sessionService.listUserSessions(req.user.id);
          const readySession = sessions.find(
            (session) => session.status === "ready",
          );
          if (!readySession) {
            throw new Error(
              "No connected WhatsApp session available. Connect a session first or specify sessionId.",
            );
          }
          chosenSessionId = readySession.id;
        }

        const chosenSession = await sessionService.getSessionById(
          req.user.id,
          chosenSessionId,
        );
        const externalId =
          chosenSession?.transportType === "whatsapp_cloud"
            ? WhatsAppMetaService.externalIdForWaId(phoneNumber)
            : await chatService.normalizeWhatsappExternalId(phoneNumber);

        targetChat = await chatService.ensureChatForWhatsappId({
          userId: req.user.id,
          externalId,
          sessionId: chosenSessionId,
          displayName: displayName || phoneNumber,
        });
      }

      const result = await chatService.createOutgoingMessage({
        userId: req.user.id,
        chatId: targetChat.id,
        body,
        type: effectiveType,
        mediaFileId: effectiveMediaFileId,
        replyToId,
      });

      await deliverOutgoingApiMessage({
        userId: req.user.id,
        result,
        sessionManager,
        io: req.app.get("io"),
      });

      emitChatResult(req.app.get("io"), req.user.id, result);
      res.json(result);
    } catch (error) {
      res.status(error?.code === "P1008" ? 503 : 400).json({
        error:
          error?.code === "P1008"
            ? "Database is busy. Please try again."
            : error.message,
      });
    }
  });

  app.put(
    "/api/contacts/:contactId",
    requireAuth,
    withAsync(async (req, res) => {
      const { displayName, avatarUrl, persona } = req.body || {};
      const chat = await chatService.updateContact(
        req.user.id,
        req.params.contactId,
        {
          displayName,
          avatarUrl,
          persona,
        },
      );
      res.json({ chat });
    }),
  );

  app.get("/api/chats/:chatId/messages", requireAuth, async (req, res) => {
    try {
      const result = await chatService.listMessages(
        req.user.id,
        req.params.chatId,
        {
          take: req.query.take,
          before: req.query.before,
          search: req.query.search,
        },
      );
      res.json(result);
    } catch (error) {
      res.status(error?.code === "P1008" ? 503 : 404).json({
        error:
          error?.code === "P1008"
            ? "Database is busy. Please try again."
            : error.message,
      });
    }
  });

  app.post(
    "/api/chats/:chatId/messages/send",
    requireAuth,
    async (req, res) => {
      try {
        // If this chat targets an assistant instance, delegate to agent-service
        try {
          const targetChat = await chatService.getChatWithContact(
            req.user.id,
            req.params.chatId,
          );
          const externalId = targetChat?.contact?.externalId || null;
          if (
            externalId &&
            (externalId === "openwa:assistant" ||
              String(externalId).startsWith("openwa:assistant") ||
              String(externalId).endsWith(":assistant"))
          ) {
            const agentService = require("../services/agent-service");
            const io = req.app.get("io");
            await agentService.handleAssistantMessage(
              req.user.id,
              req.params.chatId,
              {
                body: req.body.body,
                type: req.body.type || "text",
                mediaFileId: req.body.mediaFileId || null,
                replyToId: req.body.replyToId || null,
              },
              {
                config,
                io,
                sessionManager,
                clientPlatform: req.headers["x-client-platform"] || null,
              },
            );
            return res.json({ ok: true });
          }
        } catch (e) {
          // ignore lookups and fall back to normal send
        }

        const type = req.body.type || "text";
        const mediaFileId = req.body.mediaFileId || null;
        const mediaUrl = req.body.mediaUrl || null;
        let effectiveType = type;
        let effectiveMediaFileId = mediaFileId;

        if (type === "text") {
          if (mediaUrl) {
            throw new Error("mediaUrl is only allowed for media message types.");
          }
          if (mediaFileId) {
            throw new Error(
              "mediaFileId is only allowed for media message types.",
            );
          }
          if (!req.body.body) {
            throw new Error("body is required for text messages.");
          }
        }

        const mediaTypes = ["image", "video", "audio", "document", "sticker"];
        const isMediaType = mediaTypes.includes(type);
        if (isMediaType && !mediaFileId && !mediaUrl) {
          throw new Error(
            "mediaFileId or mediaUrl is required for media messages.",
          );
        }

        if (mediaUrl && typeof mediaUrl === "string") {
          try {
            new URL(mediaUrl);
          } catch (error) {
            throw new Error("mediaUrl must be a valid URL.");
          }
        }

        if (mediaUrl && !effectiveMediaFileId) {
          const downloadedFile = await downloadMediaUrl(mediaUrl);
          const uploadedMedia = await chatService.createMediaFile(
            req.user.id,
            downloadedFile,
          );
          effectiveMediaFileId = uploadedMedia.id;
          effectiveType = inferMessageType(downloadedFile);
        }

        const result = await chatService.createOutgoingMessage({
          userId: req.user.id,
          chatId: req.params.chatId,
          body: req.body.body,
          type: effectiveType,
          mediaFileId: effectiveMediaFileId,
          replyToId: req.body.replyToId || null,
        });

        await deliverOutgoingApiMessage({
          userId: req.user.id,
          result,
          sessionManager,
          io: req.app.get("io"),
        });

        emitChatResult(req.app.get("io"), req.user.id, result);
        res.json(result);
      } catch (error) {
        res.status(error?.code === "P1008" ? 503 : 400).json({
          error:
            error?.code === "P1008"
              ? "Database is busy. Please try again."
              : error.message,
        });
      }
    },
  );

  app.delete("/api/messages/:messageId", requireAuth, async (req, res) => {
    try {
      const result = await chatService.deleteMessage(
        req.user.id,
        req.params.messageId,
      );
      res.json(result);
    } catch (error) {
      res.status(error?.code === "P1008" ? 503 : 400).json({
        error:
          error?.code === "P1008"
            ? "Database is busy. Please try again."
            : error.message,
      });
    }
  });

  app.post(
    "/api/messages/:messageId/forward",
    requireAuth,
    async (req, res) => {
      try {
        const result = await chatService.forwardMessage(
          req.user.id,
          req.params.messageId,
          req.body.targetChatId,
        );
        res.json(result);
      } catch (error) {
        res.status(error?.code === "P1008" ? 503 : 400).json({
          error:
            error?.code === "P1008"
              ? "Database is busy. Please try again."
              : error.message,
        });
      }
    },
  );

  app.post(
    "/api/media",
    requireAuth,
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "File is required." });
        }

        const mediaFile = await chatService.createMediaFile(
          req.user.id,
          req.file,
        );
        return res.status(201).json({
          mediaFile,
          type: inferMessageType(req.file),
        });
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    },
  );

  app.use((req, res) => {
    res.status(404).json({ error: "Route not found." });
  });

  return app;
}

module.exports = { createApp };
