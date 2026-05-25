const assert = require("assert");

(async () => {
  try {
    process.env.WHATSAPP_STRICT_CONNECTED_HEALTH = "true";
    process.env.WHATSAPP_HEALTH_PROBE_INTERVAL_MS = "1";

    const { WwebjsAdapter } = require("../server/whatsapp/adapters/wwebjs-adapter");

    const connectedAdapter = new WwebjsAdapter({
      session: { id: "health-connected", userId: "user-1" },
    });
    let presenceCalls = 0;
    connectedAdapter.client = {
      info: { wid: { _serialized: "6281111111111@c.us", user: "6281111111111" } },
      getState: async () => "CONNECTED",
      sendPresenceAvailable: async () => {
        presenceCalls += 1;
      },
    };

    const connectedHealth = await connectedAdapter.healthCheck();
    assert.equal(connectedHealth.ok, true);
    assert.equal(connectedHealth.state, "CONNECTED");
    assert.equal(connectedHealth.phoneNumber, "6281111111111");
    assert.equal(presenceCalls, 1);

    const staleAdapter = new WwebjsAdapter({
      session: { id: "health-stale", userId: "user-1" },
    });
    staleAdapter.client = {
      info: { wid: { _serialized: "6282222222222@c.us", user: "6282222222222" } },
      getState: async () => null,
      sendPresenceAvailable: async () => {
        throw new Error("probe should not run before connected state");
      },
    };

    const staleHealth = await staleAdapter.healthCheck();
    assert.equal(staleHealth.ok, false);
    assert.equal(staleHealth.state, "READY_WITHOUT_STATE");

    const openingAdapter = new WwebjsAdapter({
      session: { id: "health-opening", userId: "user-1" },
    });
    openingAdapter.client = {
      info: { wid: { _serialized: "6283333333333@c.us", user: "6283333333333" } },
      getState: async () => "OPENING",
      sendPresenceAvailable: async () => {
        throw new Error("probe should not run before connected state");
      },
    };

    const openingHealth = await openingAdapter.healthCheck();
    assert.equal(openingHealth.ok, false);
    assert.equal(openingHealth.state, "OPENING");

    console.log("wwebjs health check checks passed");
    process.exit(0);
  } catch (error) {
    console.error("wwebjs health check checks failed:", error);
    process.exit(1);
  }
})();
