const EventEmitter = require("events");
const QRCode = require("qrcode");

class MockAdapter extends EventEmitter {
  constructor({ session }) {
    super();
    this.session = session;
    this.connected = false;
  }

  async connect() {
    this.emit("status", { status: "connecting", transportType: "mock" });
    const qrCode = await QRCode.toDataURL(`openwa:${this.session.id}:${Date.now()}`);
    this.emit("qr", { qrCode, transportType: "mock" });

    setTimeout(() => {
      this.connected = true;
      this.emit("status", { status: "ready", transportType: "mock" });
    }, 1200);
  }

  async disconnect() {
    this.connected = false;
    this.emit("status", { status: "disconnected", transportType: "mock" });
  }

  async healthCheck() {
    return {
      ok: this.connected,
      state: this.connected ? "CONNECTED" : "DISCONNECTED",
      transportType: "mock",
    };
  }

  async sendMessage(payload) {
    if (!this.connected) {
      throw new Error("Mock session is not connected yet.");
    }

    setTimeout(() => {
      this.emit("message", {
        sender: payload.recipient,
        displayName: this.session.name,
        body: `Auto reply: ${payload.body || "Media received"}`,
        type: payload.mediaFileId ? "document" : "text"
      });
    }, 1800);

    return {
      externalMessageId: `mock-${Date.now()}`
    };
  }
}

module.exports = { MockAdapter };
