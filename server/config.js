const path = require("path");
const dotenv = require("dotenv");
const { rootDir } = require("./utils/paths");

dotenv.config({ path: path.join(rootDir, ".env") });

function getConfig({ dev = false } = {}) {
  const host = process.env.HOST || "127.0.0.1";
  const frontendPort = Number(
    process.env.FE_PORT || process.env.FRONTEND_PORT || 55111,
  );
  const backendPort = Number(
    process.env.BE_PORT || process.env.BACKEND_PORT || 55222,
  );
  const publicHost = [
    "0.0.0.0",
    "127.0.0.1",
    "localhost",
    "::1",
    "[::1]",
  ].includes(host)
    ? "localhost"
    : host;
  const frontendUrl = `http://${publicHost}:${frontendPort}`;
  const backendUrl = `http://${publicHost}:${backendPort}`;

  return {
    dev,
    host,
    frontendPort,
    backendPort,
    frontendUrl,
    backendUrl,
    appUrl: frontendUrl,
    jwtSecret:
      process.env.WANIE_JWT_SECRET ||
      process.env.OPENWA_JWT_SECRET ||
      "wanie-local-dev-secret",
    autoOpenBrowser:
      (process.env.WANIE_AUTO_OPEN || process.env.OPENWA_AUTO_OPEN) !==
      "false",
    useWwebjs:
      (process.env.WANIE_USE_WWEBJS || process.env.OPENWA_USE_WWEBJS) !==
      "false",
    allowMockAdapter:
      (process.env.WANIE_ALLOW_MOCK || process.env.OPENWA_ALLOW_MOCK) ===
      "true",
  };
}

module.exports = { getConfig };
