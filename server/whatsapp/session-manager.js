const EventEmitter = require("events");
const { MockAdapter } = require("./adapters/mock-adapter");
const { WwebjsAdapter } = require("./adapters/wwebjs-adapter");
const chatService = require("../services/chat-service");
const sessionService = require("../services/session-service");

function formatTransportError(transportType, error) {
  const message = String(error?.message || error || "Unknown error");
  if (transportType === "wwebjs" && message.includes("Cannot find module")) {
    return "whatsapp-web.js is not installed. Run `npm install whatsapp-web.js` in the Wanie package, then try Connect again.";
  }

  return `${transportType} failed: ${message}`;
}

function safeAsyncListener(handler, label) {
  return (...args) => {
    Promise.resolve(handler(...args)).catch((error) => {
      console.error(`Session manager listener failed (${label}).`, error);
    });
  };
}

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class SessionManager extends EventEmitter {
  constructor({ config }) {
    super();
    this.config = config;
    this.adapters = new Map();
    this.retryTimers = new Map();
    this.manualDisconnects = new Set();
    this.qrPersistTimers = new Map();
    this.queuedQrStates = new Map();
    this.reconnectAttempts = new Map();
    this.healthInProgress = new Set();
    this.healthTimer = null;
    this.resetInProgress = false;
    this.healthIntervalMs = envNumber("WHATSAPP_HEALTH_INTERVAL_MS", 30000);
    this.healthTimeoutMs = envNumber("WHATSAPP_HEALTH_TIMEOUT_MS", 10000);
    this.reconnectBaseDelayMs = envNumber(
      "WHATSAPP_RECONNECT_BASE_DELAY_MS",
      5000,
    );
    this.reconnectMaxDelayMs = envNumber(
      "WHATSAPP_RECONNECT_MAX_DELAY_MS",
      120000,
    );
  }

  async hydrate(sessions) {
    const reconnectable = sessions.filter(
      (session) =>
        session.status === "ready" || session.status === "connecting",
    );
    for (const session of reconnectable) {
      await this.connectSession(session.userId, session.id);
    }
  }

  async connectSession(userId, sessionId, options = {}) {
    if (this.resetInProgress) {
      throw new Error(
        "Session connection disabled while reset is in progress.",
      );
    }

    const { force = false } = options;
    this.manualDisconnects.delete(sessionId);
    this.clearRetry(sessionId);
    this.clearQueuedQrPersist(sessionId);

    const existing = this.adapters.get(sessionId);
    if (existing) {
      if (force) {
        try {
          await existing.adapter.disconnect();
        } catch (error) {
          // Ignore adapter teardown errors while forcing a fresh connect.
        }
        existing.adapter.removeAllListeners();
        this.adapters.delete(sessionId);
      } else {
        return existing.adapter;
      }
    }

    const session = await sessionService.getSessionById(userId, sessionId);
    if (!session) {
      console.warn(
        `[SessionManager] Attempted to connect non-existent session: ${sessionId}`,
      );
      throw new Error("Session not found.");
    }

    if (session.transportType === "whatsapp_cloud") {
      await sessionService.touchSessionState(session.id, {
        status: "ready",
        qrCode: null,
        lastError: null,
        lastHealthCheckAt: new Date(),
        lastSeenAt: new Date(),
        reconnectAttempts: 0,
      });
      this.emit("session-status", {
        id: session.id,
        userId: session.userId,
        sessionId: session.id,
        status: "ready",
        transportType: "whatsapp_cloud",
        lastError: null,
        qrCode: null,
      });
      return null;
    }

    await sessionService.touchSessionState(session.id, {
      status: "connecting",
      qrCode: null,
      lastError: null,
      transportType: this.config.useWwebjs ? "wwebjs" : "mock",
    });

    const candidates = [];

    if (this.config.useWwebjs) {
      candidates.push({
        adapter: new WwebjsAdapter({ session }),
        transportType: "wwebjs",
      });
    }

    if (this.config.allowMockAdapter) {
      candidates.push({
        adapter: new MockAdapter({ session }),
        transportType: "mock",
      });
    }

    if (candidates.length === 0) {
      throw new Error(
        "No WhatsApp transport is enabled. Enable whatsapp-web.js or set WANIE_ALLOW_MOCK=true for mock mode.",
      );
    }

    let previousError = null;

    for (const candidate of candidates) {
      try {
        this.attachAdapter({
          session,
          adapter: candidate.adapter,
          transportType: candidate.transportType,
        });

        await sessionService.touchSessionState(session.id, {
          status: "connecting",
          transportType: candidate.transportType,
          lastError: previousError,
          lastHealthCheckAt: new Date(),
        });

        await candidate.adapter.connect();
        return candidate.adapter;
      } catch (error) {
        // DEBUG: Print full error stack for diagnosis
        console.error(
          "[Wanie] Adapter connect error:",
          error && error.stack ? error.stack : error,
        );
        this.adapters.delete(session.id);
        candidate.adapter.removeAllListeners();
        try {
          await candidate.adapter.disconnect();
        } catch (disconnectError) {
          // Ignore cleanup errors after a failed connect attempt.
        }
        previousError = formatTransportError(candidate.transportType, error);
      }
    }

    await sessionService.touchSessionState(session.id, {
      status: "error",
      qrCode: null,
      lastError: previousError,
    });

    this.emit("session-status", {
      id: session.id,
      userId: session.userId,
      sessionId: session.id,
      status: "error",
      lastError: previousError,
      qrCode: null,
    });

    throw new Error(previousError || "Unable to connect session.");
  }

  attachAdapter({ session, adapter, transportType }) {
    adapter.on(
      "qr",
      safeAsyncListener(async (payload) => {
        this.queueQrStatePersist(session.id, {
          status: "connecting",
          qrCode: payload.qrCode,
          transportType: payload.transportType || transportType,
        });

        this.emit("session-status", {
          id: session.id,
          userId: session.userId,
          sessionId: session.id,
          status: "connecting",
          qrCode: payload.qrCode,
          transportType: payload.transportType || transportType,
        });
      }, "qr"),
    );

    adapter.on(
      "status",
      safeAsyncListener(async (payload) => {
        const currentRecord = this.adapters.get(session.id);
        if (currentRecord) {
          currentRecord.status = payload.status;
          currentRecord.transportType = payload.transportType || transportType;
        }

        const nextQrCode =
          payload.status === "ready" ||
          payload.status === "disconnected" ||
          payload.status === "error"
            ? null
            : undefined;

        if (payload.status === "ready") {
          this.clearRetry(session.id);
          this.reconnectAttempts.delete(session.id);
        }

        if (
          payload.status === "ready" ||
          payload.status === "disconnected" ||
          payload.status === "error"
        ) {
          this.clearQueuedQrPersist(session.id);
        }

        await sessionService.touchSessionState(session.id, {
          status: payload.status,
          transportType: payload.transportType || transportType,
          lastError: payload.lastError || null,
          qrCode: nextQrCode,
          phoneNumber: payload.phoneNumber || undefined,
          lastSeenAt: payload.status === "ready" ? new Date() : undefined,
          lastHealthCheckAt:
            payload.status === "ready" ? new Date() : undefined,
          reconnectAttempts: payload.status === "ready" ? 0 : undefined,
        });

        this.emit("session-status", {
          id: session.id,
          userId: session.userId,
          sessionId: session.id,
          status: payload.status,
          transportType: payload.transportType || transportType,
          lastError: payload.lastError || null,
          qrCode: nextQrCode,
          phoneNumber: payload.phoneNumber || undefined,
          lastSeenAt: payload.status === "ready" ? new Date() : undefined,
          lastHealthCheckAt:
            payload.status === "ready" ? new Date() : undefined,
          reconnectAttempts: payload.status === "ready" ? 0 : undefined,
        });

        if (
          payload.status === "ready" &&
          typeof adapter.getSyncSnapshot === "function"
        ) {
          try {
            // Emit a starting event so UI can show a specific "syncing" state
            this.emit("workspace-sync-started", {
              id: session.id,
              userId: session.userId,
              sessionId: session.id,
              status: "syncing",
            });

            const snapshot = await adapter.getSyncSnapshot();
            await chatService.syncWhatsappSnapshot({
              userId: session.userId,
              sessionId: session.id,
              contacts: snapshot.contacts,
              chats: snapshot.chats,
            });

            this.emit("workspace-sync", {
              id: session.id,
              userId: session.userId,
              sessionId: session.id,
              status: "completed",
            });
          } catch (error) {
            const lastError = `WhatsApp sync failed: ${error.message}`;
            console.error(
              `[SessionManager] Sync error for session ${session.id}:`,
              error,
            );

            await sessionService.touchSessionState(session.id, {
              lastError,
            });

            this.emit("workspace-sync", {
              id: session.id,
              userId: session.userId,
              sessionId: session.id,
              status: "failed",
              error: lastError,
            });

            this.emit("session-status", {
              id: session.id,
              userId: session.userId,
              sessionId: session.id,
              status: payload.status,
              transportType: payload.transportType || transportType,
              lastError,
              qrCode: nextQrCode,
            });
          }
        }

        if (payload.status === "disconnected" || payload.status === "error") {
          this.adapters.delete(session.id);
          if (!this.manualDisconnects.has(session.id)) {
            this.scheduleReconnect(session.userId, session.id, payload.status);
          }
        }
      }, "status"),
    );

    adapter.on("message", (payload) => {
      this.emit("incoming-message", {
        userId: session.userId,
        sessionId: session.id,
        ...payload,
      });
    });

    this.adapters.set(session.id, {
      adapter,
      status: "connecting",
      transportType,
    });
  }

  async disconnectSession(userId, sessionId) {
    this.manualDisconnects.add(sessionId);
    this.clearRetry(sessionId);
    this.reconnectAttempts.delete(sessionId);
    this.clearQueuedQrPersist(sessionId);
    const session = await sessionService.getSessionById(userId, sessionId);
    if (!session) {
      throw new Error("Session not found.");
    }

    const record = this.adapters.get(sessionId);
    if (record) {
      await record.adapter.disconnect();
      this.adapters.delete(sessionId);
    }

    await sessionService.touchSessionState(sessionId, {
      status: "disconnected",
      qrCode: null,
      lastError: null,
      reconnectAttempts: 0,
    });
  }

  async sendMessage(sessionId, payload) {
    const record = this.adapters.get(sessionId);
    if (!record) {
      throw new Error("Session is not connected.");
    }

    return record.adapter.sendMessage(payload);
  }

  scheduleReconnect(userId, sessionId, reason) {
    if (this.resetInProgress || this.retryTimers.has(sessionId)) {
      return;
    }

    const nextAttempt = (this.reconnectAttempts.get(sessionId) || 0) + 1;
    this.reconnectAttempts.set(sessionId, nextAttempt);
    const exponentialDelay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * 2 ** Math.max(0, nextAttempt - 1),
    );
    const jitter = Math.floor(Math.random() * Math.min(1000, exponentialDelay));
    const delayMs = exponentialDelay + jitter;

    sessionService
      .touchSessionState(sessionId, {
        reconnectAttempts: nextAttempt,
        lastError: `Reconnect scheduled after ${reason} in ${Math.round(delayMs / 1000)}s.`,
      })
      .catch((error) => {
        console.warn(
          `[SessionManager] Failed to persist reconnect attempt for ${sessionId}:`,
          error.message,
        );
      });

    const timer = setTimeout(async () => {
      this.retryTimers.delete(sessionId);

      if (this.resetInProgress || this.manualDisconnects.has(sessionId)) {
        return;
      }

      try {
        await this.connectSession(userId, sessionId);
      } catch (error) {
        await sessionService.touchSessionState(sessionId, {
          status: "error",
          lastError: `Reconnect failed after ${reason}: ${error.message}`,
          reconnectAttempts: this.reconnectAttempts.get(sessionId) || nextAttempt,
        });

        this.emit("session-status", {
          id: sessionId,
          userId,
          sessionId,
          status: "error",
          lastError: `Reconnect failed after ${reason}: ${error.message}`,
          reconnectAttempts: this.reconnectAttempts.get(sessionId) || nextAttempt,
          qrCode: null,
        });

        this.scheduleReconnect(userId, sessionId, reason);
      }
    }, delayMs);

    this.retryTimers.set(sessionId, timer);
  }

  clearRetry(sessionId) {
    const timer = this.retryTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(sessionId);
    }
  }

  async runHealthCheckOnce() {
    if (this.resetInProgress) return [];

    const checks = Array.from(this.adapters.entries()).map(
      async ([sessionId, record]) => {
        if (this.healthInProgress.has(sessionId)) return null;
        if (this.manualDisconnects.has(sessionId)) return null;

        this.healthInProgress.add(sessionId);
        try {
          if (record.status !== "ready") return null;
          return await this.checkSessionHealth(sessionId, record);
        } finally {
          this.healthInProgress.delete(sessionId);
        }
      },
    );

    const results = await Promise.allSettled(checks);
    return results
      .map((result) => (result.status === "fulfilled" ? result.value : null))
      .filter(Boolean);
  }

  async checkSessionHealth(sessionId, record) {
    const adapter = record?.adapter;
    const now = new Date();
    if (!adapter || typeof adapter.healthCheck !== "function") {
      return null;
    }

    let health;
    try {
      health = await withTimeout(
        adapter.healthCheck(),
        this.healthTimeoutMs,
        `WhatsApp health check timed out after ${this.healthTimeoutMs}ms.`,
      );
    } catch (error) {
      await this.handleUnhealthySession(sessionId, {
        reason: error.message,
        checkedAt: now,
      });
      return { sessionId, ok: false, error: error.message };
    }

    if (!health?.ok) {
      await this.handleUnhealthySession(sessionId, {
        reason: `WhatsApp health check failed: ${health?.state || "unknown state"}`,
        checkedAt: now,
      });
      return { sessionId, ok: false, state: health?.state || null };
    }

    const session = await sessionService.touchSessionState(sessionId, {
      status: "ready",
      qrCode: null,
      lastError: null,
      lastHealthCheckAt: now,
      lastSeenAt: now,
      phoneNumber: health.phoneNumber || undefined,
      reconnectAttempts: 0,
    });
    this.reconnectAttempts.delete(sessionId);

    if (session) {
      this.emit("session-status", {
        id: session.id,
        userId: session.userId,
        sessionId: session.id,
        status: "ready",
        transportType: health.transportType || session.transportType,
        lastError: null,
        qrCode: null,
        phoneNumber: health.phoneNumber || session.phoneNumber || undefined,
        lastHealthCheckAt: now,
        lastSeenAt: now,
        reconnectAttempts: 0,
      });
    }

    return { sessionId, ok: true, state: health.state || null };
  }

  async handleUnhealthySession(sessionId, { reason, checkedAt = new Date() }) {
    const session = await sessionService.touchSessionState(sessionId, {
      status: "error",
      qrCode: null,
      lastError: reason,
      lastHealthCheckAt: checkedAt,
    });

    if (session) {
      this.emit("session-status", {
        id: session.id,
        userId: session.userId,
        sessionId: session.id,
        status: "error",
        transportType: session.transportType,
        lastError: reason,
        qrCode: null,
        lastHealthCheckAt: checkedAt,
        lastSeenAt: session.lastSeenAt,
        reconnectAttempts: session.reconnectAttempts,
      });
    }

    await this.teardownAdapter(sessionId);

    if (session && !this.manualDisconnects.has(sessionId)) {
      this.scheduleReconnect(session.userId, session.id, "health-check");
    }
  }

  async teardownAdapter(sessionId) {
    const existing = this.adapters.get(sessionId);
    if (!existing) return;

    this.adapters.delete(sessionId);
    try {
      existing.adapter.removeAllListeners();
    } catch (error) {
      // ignore listener cleanup errors
    }
    try {
      await withTimeout(
        existing.adapter.disconnect(),
        this.healthTimeoutMs,
        `WhatsApp adapter teardown timed out after ${this.healthTimeoutMs}ms.`,
      );
    } catch (error) {
      console.warn(
        `[SessionManager] Failed to teardown unhealthy session ${sessionId}:`,
        error.message,
      );
    }
  }

  startHealthCheckWorker() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.runHealthCheckOnce().catch((error) => {
        console.error("[SessionManager] WhatsApp health check failed:", error);
      });
    }, this.healthIntervalMs);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  stopHealthCheckWorker() {
    if (!this.healthTimer) return;
    clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  queueQrStatePersist(sessionId, data) {
    this.queuedQrStates.set(sessionId, {
      ...(this.queuedQrStates.get(sessionId) || {}),
      ...data,
    });

    if (this.qrPersistTimers.has(sessionId)) {
      return;
    }

    const timer = setTimeout(() => {
      const pendingState = this.queuedQrStates.get(sessionId);
      this.qrPersistTimers.delete(sessionId);
      this.queuedQrStates.delete(sessionId);

      if (!pendingState) {
        return;
      }

      sessionService
        .touchSessionState(sessionId, pendingState)
        .catch((error) => {
          console.error(
            `Failed to persist queued QR state for session ${sessionId}.`,
            error,
          );
        });
    }, 400);

    this.qrPersistTimers.set(sessionId, timer);
  }

  clearQueuedQrPersist(sessionId) {
    const timer = this.qrPersistTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.qrPersistTimers.delete(sessionId);
    }

    this.queuedQrStates.delete(sessionId);
  }

  async stopAll() {
    this.resetInProgress = true;
    this.stopHealthCheckWorker();
    for (const [sessionId, existing] of Array.from(this.adapters.entries())) {
      try {
        this.manualDisconnects.add(sessionId);

        if (
          existing?.adapter &&
          typeof existing.adapter.disconnect === "function"
        ) {
          await existing.adapter.disconnect();
        }
      } catch (error) {
        console.warn(
          `[SessionManager] Failed to disconnect session ${sessionId}:`,
          error.message,
        );
      }
      try {
        existing.adapter?.removeAllListeners();
      } catch (error) {
        // ignore
      }
      this.clearRetry(sessionId);
      this.reconnectAttempts.delete(sessionId);
      this.clearQueuedQrPersist(sessionId);
      this.adapters.delete(sessionId);
    }
    this.resetInProgress = false;
  }
}

module.exports = { SessionManager };
