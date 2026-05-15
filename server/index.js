const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createServer } = require("http");
const next = require("next");
const { Server } = require("socket.io");
const { getConfig } = require("./config");
const { initializeDatabase } = require("./database/init");
const { createApp } = require("./express/create-app");
const chatService = require("./services/chat-service");
const crmAutoReplyService = require("./services/crm-auto-reply-service");
const outboundDeliveryService = require("./services/outbound-delivery-service");
const webhookService = require("./services/webhook-service");
const sessionService = require("./services/session-service");
const { registerSocketHandlers, userRoom } = require("./socket/register");
const { ensureRuntimeDirs, webDir } = require("./utils/paths");
const { SessionManager } = require("./whatsapp/session-manager");
const TelegramService = require("./services/telegram-service");
function shouldProxyToBackend(req) {
  const baseHost = req.headers.host || "127.0.0.1";
  const url = new URL(req.url || "/", `http://${baseHost}`);
  return (
    url.pathname === "/health" ||
    url.pathname === "/version" ||
    url.pathname === "/docs" ||
    url.pathname.startsWith("/docs/") ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/socket.io" ||
    url.pathname.startsWith("/socket.io/") ||
    url.pathname === "/media" ||
    url.pathname.startsWith("/media/")
  );
}

async function proxyToBackend(req, res, config) {
  const targetUrl = `${config.backendUrl}${req.url}`;
  const headers = { ...req.headers };
  delete headers.host;

  const requestInit = {
    method: req.method,
    headers,
    duplex: "half",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    requestInit.body = req;
  }

  const response = await fetch(targetUrl, requestInit);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

function ensureWebBuild(config) {
  if (config.dev) {
    return;
  }

  const buildIdPath = path.join(webDir, ".next", "BUILD_ID");
  if (fs.existsSync(buildIdPath)) {
    return;
  }

  // Skip build if source files don't exist (e.g., global npm install)
  const pagesDir = path.join(webDir, "pages");
  if (!fs.existsSync(pagesDir)) {
    console.warn("⚠️  Web dashboard source files not found. Skipping build.");
    console.warn(
      "   Dashboard might not be available. This is expected for global npm installs.",
    );
    return;
  }

  console.log(
    "Next.js production build not found. Building dashboard automatically...",
  );
  const result = spawnSync("npm", ["run", "build:web"], {
    cwd: path.dirname(webDir),
    stdio: "inherit",
    env: process.env,
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error("Automatic Next.js build failed.");
  }
}

async function startOpenWA({ dev = false } = {}) {
  // Dynamic import for ESM module
  const openModule = await import("open");
  const openBrowser = openModule.default || openModule;

  const config = getConfig({ dev });

  ensureRuntimeDirs();
  await initializeDatabase();
  ensureWebBuild(config);

  const nextApp = next({
    dev: config.dev,
    dir: webDir,
  });

  await nextApp.prepare();
  const nextHandler = nextApp.getRequestHandler();

  const sessionManager = new SessionManager({ config });
  const app = createApp({
    config,
    sessionManager,
  });

  const backendServer = createServer(app);
  const frontendServer = createServer(async (req, res) => {
    try {
      if (shouldProxyToBackend(req)) {
        await proxyToBackend(req, res, config);
        return;
      }

      await nextHandler(req, res);
    } catch (error) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  frontendServer.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }

    const baseHost = req.headers.host || "127.0.0.1";
    const url = new URL(req.url, `http://${baseHost}`);
    if (
      url.pathname === "/socket.io" ||
      url.pathname.startsWith("/socket.io/")
    ) {
      backendServer.emit("upgrade", req, socket, head);
      return;
    }

    // Allow Next.js HMR / other upgrade requests to be handled by the
    // default request flow when available.
  });

  const io = new Server(backendServer, {
    cors: {
      origin: "*",
    },
  });

  TelegramService.setIo(io);
  await TelegramService.initializeAll();

  // make io available to express routes via req.app.get('io')
  app.set("io", io);
  outboundDeliveryService.startWorker({ sessionManager, io });
  outboundDeliveryService.startCleanupWorker();
  webhookService.startWorker({ io });
  webhookService.startCleanupWorker();

  sessionManager.on("session-status", (payload) => {
    io.to(userRoom(payload.userId)).emit("session_status_update", payload);
  });

  sessionManager.on("incoming-message", async (payload) => {
    try {
      const result = await chatService.storeIncomingMessage(payload);
      io.to(userRoom(payload.userId)).emit("new_message", result.message);
      io.to(userRoom(payload.userId)).emit("contact_list_update", result.chat);

      // Fire user-configured webhook (best-effort)
      try {
        await webhookService.notifyWebhook(payload.userId, {
          chat: result.chat,
          message: result.message,
        });
      } catch (err) {
        console.error("Webhook delivery failed:", err);
      }

      // Auto-reply for CRM chats when explicitly enabled.
      try {
        await crmAutoReplyService.maybeAutoReply({
          userId: payload.userId,
          chat: result.chat,
          inboundMessage: result.message,
          io,
          sessionManager,
          userRoom,
        });
      } catch (err) {
        console.error("CRM auto-reply failed:", err);
      }
    } catch (error) {
      console.error("Failed to persist incoming WhatsApp message.", error);
    }
  });

  sessionManager.on("workspace-sync-started", (payload) => {
    io.to(userRoom(payload.userId)).emit("workspace_sync_started", payload);
  });

  sessionManager.on("workspace-sync", (payload) => {
    io.to(userRoom(payload.userId)).emit("workspace_synced", payload);
  });

  registerSocketHandlers({
    io,
    config,
    sessionManager,
  });

  await new Promise((resolve) => {
    backendServer.listen(config.backendPort, config.host, resolve);
  });

  await new Promise((resolve) => {
    frontendServer.listen(config.frontendPort, config.host, resolve);
  });

  const reconnectableSessions =
    await sessionService.listReconnectableSessions();
  await sessionManager.hydrate(reconnectableSessions);
  sessionManager.startHealthCheckWorker();

  console.log("OpenWA is running 🚀\n");
  console.log(`Dashboard: ${config.frontendUrl}`);
  console.log(`Backend API: ${config.backendUrl}`);
  console.log("WhatsApp Sessions: ready");
  console.log("Socket: connected");
  console.log("Database: connected");

  if (config.autoOpenBrowser) {
    try {
      await openBrowser(config.frontendUrl);
    } catch (error) {
      console.warn(`Browser auto-open failed: ${error.message}`);
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[OpenWA] Shutting down gracefully...");
    try {
      outboundDeliveryService.stopWorker();
      outboundDeliveryService.stopCleanupWorker();
      webhookService.stopWorker();
      webhookService.stopCleanupWorker();
      sessionManager.stopHealthCheckWorker();
      await TelegramService.stopAll();
    } catch (e) {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, backendServer, frontendServer, io };
}

module.exports = {
  startOpenWA,
};
