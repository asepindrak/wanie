const fs = require("fs");
const path = require("path");
const {
  rootDir,
  mediaDir,
  storageDir,
  workspacesDir,
  ensureRuntimeDirs,
  ensureDir,
} = require("../utils/paths");
const IDENTITY_PATH = path.join(storageDir, "IDENTITY.md");
const TOOLS_PATH = path.join(storageDir, "TOOLS.md");
const aiProviderService = require("./ai-provider-service");
const llmService = require("./llm-service");
const chatService = require("./chat-service");
const assistantService = require("./assistant-service");
const apiKeyService = require("./api-key-service");
const authService = require("./auth-service");
const webhookService = require("./webhook-service");
const sessionService = require("./session-service");
const crmService = require("./crm-service");
const terminalService = require("./terminal-service");
const orchestrator = require("./agent-orchestrator");
const toolExecutor = require("./tool-executor");
const { prisma } = require("../database/client");
const { v4: uuidv4 } = require("uuid");
const toolCredentialService = require("./tool-credential-service");
const TelegramConfigService = require("./telegram-config-service");
const TelegramService = require("./telegram-service");
const outboundDeliveryService = require("./outbound-delivery-service");
const userSettings = require("./user-settings");
const QRCode = require("qrcode");

const pendingPasswordResets = new Map();

function getPasswordResetKey(userId, chatId) {
  return `${String(userId || "")}::${String(chatId || "")}`;
}

function getPendingPasswordReset(userId, chatId) {
  return pendingPasswordResets.get(getPasswordResetKey(userId, chatId));
}

function setPendingPasswordReset(userId, chatId) {
  pendingPasswordResets.set(getPasswordResetKey(userId, chatId), {
    requestedAt: Date.now(),
  });
}

function clearPendingPasswordReset(userId, chatId) {
  pendingPasswordResets.delete(getPasswordResetKey(userId, chatId));
}

function parseNewPasswordCommand(body) {
  const text = String(body || "").trim();
  const match = text.match(/^\s*\/(?:new_password|new-password)\s+(.+)$/i);
  if (match) return match[1].trim();

  const directMatch = text.match(
    /(?:password baru|new password|kata sandi|password)[:\s]+(.+)$/i,
  );
  if (directMatch) return directMatch[1].trim();

  // Accept a plain password string once the reset flow is active
  if (text && !/\?$/i.test(text) && text.length <= 128) {
    return text;
  }

  return null;
}

function isResetPasswordTrigger(body) {
  const text = String(body || "").toLowerCase();
  return (
    /(?:\/(?:reset_password|reset-password)|\breset password\b|\bpassword reset\b|\blupa password\b|\breset sandi\b|\breset akun\b|\bpassword baru\b)/i.test(
      text,
    ) ||
    (/\breset\b/i.test(text) && /\b(password|sandi|akun)\b/i.test(text))
  );
}

function isCancelResetPassword(body) {
  const text = String(body || "").trim();
  return /^\s*(\/cancel_reset|cancel reset)\b/i.test(text);
}
const { fetchWebpage, openBrowser } = require("../utils/browser");
const OS_NAME_MAP = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const hostPlatform = process.platform || "unknown";
const hostOS = OS_NAME_MAP[hostPlatform] || hostPlatform;

function ensureToolsFile() {
  // ensure runtime dirs exist before writing into the user data dir
  try {
    ensureRuntimeDirs();
  } catch (e) {
    // ignore
  }

  if (!fs.existsSync(TOOLS_PATH)) {
    const defaultContent = `# TOOLS.md

This file documents tools and skills available to the OpenWA Assistant.

Default skills:
- add_device: create a new WhatsApp session/device for the user. Use this only for WhatsApp device/session requests, QR pairing, or WhatsApp number connection. Never use this for Telegram.
- add_llm_provider: add an LLM provider (OpenAI/Anthropic/Ollama/OpenRouter).
- update_assistant: change assistant display name, avatar, or persona.
- create_api_key: generate an API key for the user.
- update_webhook: set incoming webhook URL and key.
- setup_gateway_integration: configure OpenWA as an API gateway for an external CRM/ERP/app by setting webhook URL/key, optionally creating an API key, and turning internal CRM automation off.
- setup_telegram_bot: set up a Telegram bot to remote OpenWA. Use this for any request that mentions Telegram, Telegram bot, BotFather, bot token, or admin Telegram IDs. User must provide a bot token from @BotFather. Do not create a WhatsApp device/session for Telegram setup.
- configure_telegram_admins: set the Telegram admin chat ID allowlist. Use this only for Telegram admin access control.
- get_telegram_bot_status: check whether the user's Telegram bot is configured and currently running.
- update_tools_md: update this file with new tools/skills provided by user.

The assistant may append new tool descriptions here when the user provides external tool documentation.

Routing rules:
- If the user asks to set up, connect, configure, check, delete, or manage Telegram, use Telegram tools only.
- If the user asks to add/connect/pair a WhatsApp device or scan a WhatsApp QR code, use add_device.
- When the requested channel is ambiguous, ask one short clarification question instead of guessing.
`;

    fs.writeFileSync(TOOLS_PATH, defaultContent, "utf8");
  }
}

async function readToolsFile() {
  try {
    ensureToolsFile();
    return fs.readFileSync(TOOLS_PATH, "utf8");
  } catch (err) {
    return "";
  }
}

async function updateToolsFile({ action = "append", content = "" }) {
  ensureToolsFile();
  if (action === "replace") {
    fs.writeFileSync(TOOLS_PATH, String(content || ""), "utf8");
    return { ok: true };
  }

  // default append
  fs.appendFileSync(TOOLS_PATH, `\n${String(content || "")}\n`, "utf8");
  return { ok: true };
}

function ensureIdentityFile() {
  try {
    ensureRuntimeDirs();
  } catch (e) {
    // ignore
  }

  if (!fs.existsSync(IDENTITY_PATH)) {
    const defaultContent = `# IDENTITY.md

This file documents the user's identity and preferences for the OpenWA Assistant.

Example fields:
- name: Your Name
- displayName: Friendly name to use when addressing you
- email: you@example.com
- role: Owner
- organization: Example Corp
- timezone: Asia/Jakarta
- locale: id-ID
- bio: Short description about yourself

Edit this file so the assistant can use accurate identity/context when replying or taking actions.
`;
    fs.writeFileSync(IDENTITY_PATH, defaultContent, "utf8");
  }
}

async function readIdentityFile() {
  try {
    ensureIdentityFile();
    return fs.readFileSync(IDENTITY_PATH, "utf8");
  } catch (err) {
    return "";
  }
}

// Register an external tool manifest: validate, persist registry, and append to TOOLS.md
async function registerExternalTool(
  userId,
  manifest = {},
  { overwrite = false } = {},
) {
  try {
    ensureRuntimeDirs();
  } catch (e) {
    // ignore
  }
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }

  const id = String(manifest.id || "").trim();
  const name = String(manifest.name || "").trim();
  const description = String(manifest.description || "").trim();

  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      "manifest.id is required and must be alphanumeric (dash/underscore allowed)",
    );
  }
  if (!name) throw new Error("manifest.name is required");
  if (!description) throw new Error("manifest.description is required");

  const registryPath = path.join(storageDir, "tools_registry.json");
  let registry = {};
  try {
    if (fs.existsSync(registryPath)) {
      const raw = fs.readFileSync(registryPath, "utf8");
      registry = raw ? JSON.parse(raw) : {};
    }
  } catch (e) {
    registry = {};
  }

  if (registry[id] && !overwrite) {
    throw new Error(`tool with id '${id}' already exists`);
  }

  const invokeVal = manifest.invoke || manifest.type || "none";

  const entry = {
    id,
    name,
    description,
    docs: manifest.docs || manifest.docsUrl || null,
    invoke: invokeVal,
    // allow invocation automatically when the manifest includes an explicit HTTP base URL
    invokeEnabled: /^https?:\/\//i.test(String(invokeVal || "")),
    example: manifest.example || null,
    addedBy: userId,
    addedAt: new Date().toISOString(),
  };

  registry[id] = entry;

  try {
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");
  } catch (e) {
    throw new Error(`failed to write registry: ${e.message}`);
  }

  // Append a human-readable entry to TOOLS.md
  const append = `### Tool: ${entry.name} (${entry.id})\n\n${entry.description}\n\nDocs: ${entry.docs || "N/A"}\nInvoke: ${entry.invoke}\n\n`;
  await updateToolsFile({ action: "append", content: append });

  // Clean duplicates in TOOLS.md so older entries for the same tool id are removed
  try {
    const toolsText = await readToolsFile();
    const cleaned = removeDuplicateToolEntries(toolsText);
    if (cleaned !== toolsText) {
      await updateToolsFile({ action: "replace", content: cleaned });
    }
  } catch (e) {
    // ignore cleanup errors
  }

  return { ok: true, tool: entry };
}

// Remove duplicate "### Tool: Name (id)" blocks.
// Keep only the last occurrence when duplicates are detected by:
// - exact tool id
// - normalized docs URL
// - slugified tool name
// This helps avoid repeated entries appended for the same tool when
// registration happens multiple times using different ids or manifests.
function removeDuplicateToolEntries(content) {
  if (!content) return content;
  const lines = content.split(/\r?\n/);
  const entries = [];
  const headerRe = /^###\s+Tool:\s*(.*?)\s*\(([^)]+)\)\s*$/;

  function normalizeDocsUrl(u) {
    if (!u) return null;
    try {
      const url = new URL(String(u).trim());
      // keep origin + pathname, remove trailing slash
      return (url.origin + url.pathname).replace(/\/+$/, "").toLowerCase();
    } catch (e) {
      return String(u || "")
        .trim()
        .replace(/\/+$/, "")
        .toLowerCase();
    }
  }

  // find all entry blocks and capture id, name, docs line
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (m) {
      const name = String(m[1] || "").trim();
      const id = String(m[2] || "").trim();
      const start = i;
      // find end of block (next header or EOF)
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].match(headerRe)) {
          end = j;
          break;
        }
      }

      // look for Docs: line within block
      let docsRaw = null;
      for (let k = start + 1; k < end; k++) {
        const dm = lines[k].match(/^\s*Docs:\s*(\S.*)$/i);
        if (dm) {
          docsRaw = dm[1].trim();
          break;
        }
      }

      entries.push({
        id,
        name,
        nameKey: slugify(name),
        docsRaw,
        docsKey: docsRaw ? normalizeDocsUrl(docsRaw) : null,
        start,
        end,
      });

      i = end - 1;
    }
  }

  if (entries.length === 0) return content;

  // compute last occurrence index for each key we care about
  const lastIndexForKey = {};
  entries.forEach((e, idx) => {
    lastIndexForKey[`id:${e.id}`] = idx;
    if (e.docsKey) lastIndexForKey[`docs:${e.docsKey}`] = idx;
    if (e.nameKey) lastIndexForKey[`name:${e.nameKey}`] = idx;
  });

  // mark any entry that is NOT the last occurrence for any of its keys
  const toRemoveRanges = [];
  entries.forEach((e, idx) => {
    const keys = [`id:${e.id}`];
    if (e.docsKey) keys.push(`docs:${e.docsKey}`);
    if (e.nameKey) keys.push(`name:${e.nameKey}`);

    const shouldRemove = keys.some((k) => lastIndexForKey[k] !== idx);
    if (shouldRemove) toRemoveRanges.push({ start: e.start, end: e.end });
  });

  if (toRemoveRanges.length === 0) return content;

  // build new content skipping removed ranges
  const removed = new Set();
  toRemoveRanges.forEach((r) => {
    for (let k = r.start; k < r.end; k++) removed.add(k);
  });

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!removed.has(i)) out.push(lines[i]);
  }

  // normalize multiple blank lines
  let result = out.join("\n");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
}

async function fetchAndRegisterTool(userId, options = {}) {
  const { url, apiKey, headerName, overwrite = false } = options || {};
  if (!url) throw new Error("url is required");

  const normalized = String(url).trim();
  let res;
  try {
    const headers = {};
    if (apiKey) {
      const hn = headerName ? String(headerName) : "Authorization";
      headers[hn] =
        hn.toLowerCase() === "authorization" && !/^\s*Bearer\s+/i.test(apiKey)
          ? `Bearer ${apiKey}`
          : apiKey;
    }

    res = await fetch(normalized, {
      method: "GET",
      headers,
      redirect: "follow",
    });
  } catch (err) {
    throw new Error(`failed to fetch url: ${err.message}`);
  }

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  let json = null;
  let text = null;

  if (ct.includes("application/json") || ct.includes("+json")) {
    try {
      json = await res.json();
    } catch (e) {
      text = await res.text();
    }
  } else {
    text = await res.text();
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
  }

  // Build a manifest from discovered content
  let manifest = null;
  try {
    if (json && typeof json === "object") {
      if (json.id && json.name && json.description) {
        manifest = {
          id: String(json.id),
          name: String(json.name),
          description: String(json.description),
          docs: normalized,
          invoke: json.invoke || null,
          example: json.example || null,
        };
      } else if (json.openapi || json.swagger) {
        const info = json.info || {};
        const title = String(info.title || new URL(normalized).hostname);
        const description = String(
          info.description || `OpenAPI imported from ${normalized}`,
        );
        const id = slugify(title || normalized);

        // Try to determine a usable base URL from OpenAPI/Swagger document
        let invokeVal = "openapi";
        try {
          if (
            Array.isArray(json.servers) &&
            json.servers[0] &&
            json.servers[0].url
          ) {
            const serverUrl = String(json.servers[0].url || "").trim();
            if (serverUrl) {
              invokeVal = /^https?:\/\//i.test(serverUrl)
                ? serverUrl
                : new URL(serverUrl, normalized).toString();
            }
          } else if (json.swagger && (json.host || json.basePath)) {
            // Swagger 2.0: build from schemes, host and basePath
            const scheme =
              Array.isArray(json.schemes) && json.schemes[0]
                ? json.schemes[0]
                : "https";
            const host = json.host || new URL(normalized).hostname;
            const basePath = json.basePath || "/";
            invokeVal = `${scheme}://${host}${basePath}`;
          } else {
            // fallback to origin of docs URL
            invokeVal = new URL(normalized).origin;
          }
        } catch (e) {
          invokeVal = "openapi";
        }

        manifest = {
          id,
          name: title,
          description,
          docs: normalized,
          invoke: invokeVal,
        };
      } else if (json.name && json.description) {
        const id = slugify(String(json.name));
        manifest = {
          id,
          name: json.name,
          description: json.description,
          docs: normalized,
        };
      } else {
        const id = slugify(normalized);
        const name = `Imported from ${new URL(normalized).hostname}`;
        manifest = {
          id,
          name,
          description: `Imported JSON from ${normalized}`,
          docs: normalized,
        };
      }
    } else {
      const id = slugify(normalized);
      const name = `Imported from ${new URL(normalized).hostname}`;
      manifest = {
        id,
        name,
        description: `Imported from ${normalized}`,
        docs: normalized,
      };
    }
  } catch (e) {
    throw new Error(`failed to build manifest: ${e.message}`);
  }

  // Persist via existing registry helper
  const result = await registerExternalTool(userId, manifest, { overwrite });

  // If an apiKey was provided when fetching the manifest, store it securely
  if (apiKey) {
    try {
      await toolCredentialService.saveCredential(userId, result.tool.id, {
        apiKey,
        headerName: headerName || "Authorization",
      });
      // annotate result so callers may know credential was stored
      result.credentialSaved = true;
    } catch (e) {
      result.credentialSaved = false;
      result.credentialError = String(e && e.message ? e.message : e);
    }
  }

  return result;
}

async function chooseProviderId(userId) {
  const providers = await aiProviderService.listProviders(userId);
  if (!providers || providers.length === 0) return null;
  return providers[0].id;
  const identityText = await readIdentityFile();
}

function tryParseJsonObject(text) {
  if (!text) return null;
  // Look for the last JSON object in the string to allow trailing prose if needed,
  // but usually models put the JSON at the end or start.
  // We'll stick to finding the first/main block.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  // If the text contains triple backticks around the JSON, take the part inside
  let jsonStr = m[0];
  const markdownMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
  if (markdownMatch) {
    jsonStr = markdownMatch[1];
  }
  try {
    const parsed = JSON.parse(jsonStr);
    // Store where the JSON block (or markdown block containing it) started
    parsed.__jsonStart = markdownMatch ? markdownMatch.index : m.index;
    return parsed;
  } catch (e) {
    return null;
  }
}

function parseProviderSetupInput(text) {
  const payload = tryParseJsonObject(text);
  if (!payload || typeof payload !== "object") return null;

  const provider = String(payload.provider || payload.providerId || "").trim();
  const name = String(payload.name || provider || "").trim();
  const apiKey = String(
    payload.config?.apiKey || payload.apiKey || payload.key || "",
  ).trim();
  const model = String(
    payload.defaultModel || payload.model || payload.defaultAiModel || "",
  ).trim();
  const host = String(
    payload.config?.host || payload.host || payload.endpoint || "",
  ).trim();

  if (!provider || !apiKey) return null;

  return {
    provider,
    name,
    config: {
      apiKey,
      ...(payload.config || {}),
      ...(host ? { host } : {}),
    },
    defaultModel: model || null,
  };
}

const APP_LAUNCH_INTENT_RE =
  /\b(?:buka(?:kan)?|open|jalankan|run|launch|start)\b/i;
const WINDOWS_APP_COMMANDS = {
  notepad: 'start "" notepad',
  calculator: 'start "" calc',
  calc: 'start "" calc',
  paint: 'start "" mspaint',
  explorer: 'start "" explorer',
  terminal: 'start "" wt',
  cmd: 'start "" cmd',
};
const LOCAL_APP_ALIASES = {
  notepad: ["notepad", "notepad.exe", "editor teks", "text editor"],
  calculator: ["calculator", "calc", "kalkulator"],
  paint: ["paint", "mspaint"],
  explorer: ["explorer", "file explorer", "folder"],
  terminal: ["terminal", "windows terminal", "wt"],
  cmd: ["cmd", "command prompt", "prompt perintah"],
};

function normalizeClientPlatform(platform) {
  const value = String(platform || "")
    .trim()
    .toLowerCase();
  if (!value) return hostPlatform;
  if (value.includes("win")) return "win32";
  if (value.includes("mac") || value.includes("darwin")) return "darwin";
  if (value.includes("linux")) return "linux";
  return value;
}

function getClientPlatform(ctx = {}) {
  return normalizeClientPlatform(
    ctx.clientPlatform ||
      (ctx.socket &&
        ctx.socket.handshake &&
        ctx.socket.handshake.auth &&
        ctx.socket.handshake.auth.platform) ||
      hostPlatform,
  );
}

function detectLocalAppName(message) {
  const text = String(message || "").toLowerCase();
  for (const [appName, aliases] of Object.entries(LOCAL_APP_ALIASES)) {
    if (aliases.some((alias) => text.includes(alias))) {
      return appName;
    }
  }
  return null;
}

function buildLocalAppLaunchCommand(appName, platform) {
  if (!appName) return null;
  if (platform === "win32") {
    return WINDOWS_APP_COMMANDS[appName] || null;
  }
  return null;
}

function resolveDirectAssistantToolCall(userMessage, ctx = {}) {
  const text = String(userMessage || "").trim();
  if (!text || !APP_LAUNCH_INTENT_RE.test(text)) return null;

  const platform = getClientPlatform(ctx);
  const appName = detectLocalAppName(text);
  const command = buildLocalAppLaunchCommand(appName, platform);
  if (!command) return null;

  const label =
    appName === "cmd"
      ? "Command Prompt"
      : appName.charAt(0).toUpperCase() + appName.slice(1);

  return {
    tool: "run_terminal",
    args: {
      command,
      approvalMode: "auto",
      trustedAuto: true,
      timeout: 15000,
    },
    directSummary: `Saya menjalankan ${label} di ${OS_NAME_MAP[platform] || platform}.`,
  };
}

function buildAssistantSystemPrompt({
  assistantDisplayName,
  assistantExternalId,
  assistantPersona,
  toolsText,
  openapiText,
  identityText,
  clientPlatform,
}) {
  const personaText = String(assistantPersona || "").trim();
  const identitySection = String(identityText || "").trim()
    ? `\n\nIDENTITY.md:\n${String(identityText || "").trim()}`
    : "";
  const platformName = OS_NAME_MAP[clientPlatform] || clientPlatform || hostOS;
  const personaSection = personaText
    ? `Assistant Persona (Your Personality & Tone):\n${personaText}\n\n`
    : "";

  const toolsList = Object.keys(tools || {}).join(", ");

  const parts = [];
  parts.push(
    `You are ${assistantDisplayName}, an autonomous OpenWA assistant. Your goal is to complete user tasks by planning and executing multiple steps using available tools.`,
  );
  if (personaSection) parts.push(personaSection);
  parts.push("Assistant profile:");
  parts.push(`- displayName: ${assistantDisplayName}`);
  parts.push(`- externalId: ${assistantExternalId}`);
  parts.push(`- hostOS: ${hostOS}`);
  parts.push(`- userPlatform: ${platformName}`);
  parts.push(`- workspacesRoot: ${workspacesDir}`);
  parts.push("");
  parts.push("Response format rules:");
  parts.push(
    "- When you are not calling a tool, write in concise GitHub-flavored Markdown.",
  );
  parts.push("- Use short paragraphs by default.");
  parts.push(
    "- Use flat bullet or numbered lists only when the content is naturally list-shaped.",
  );
  parts.push(
    "- Use fenced code blocks for commands, JSON, or multi-line snippets.",
  );
  parts.push(
    "- Use inline code for commands, paths, env vars, and identifiers.",
  );
  parts.push("- Do not wrap normal prose in code fences.");
  parts.push(
    "- When you want to execute a tool, YOU MUST RESPOND with a JSON object. You can optionally include your thinking/planning prose BEFORE the JSON object.",
  );
  parts.push(
    "- If you include prose, wrap the tool-call JSON in a JSON code block (for example, a triple-backtick fence with the language set to 'json').",
  );
  parts.push(
    "- Respond in the same language as the user's message. If unsure, default to English.",
  );
  parts.push("");
  parts.push("Strategy & Autonomy:");
  parts.push(
    "Tool routing is strict: Telegram requests and WhatsApp device requests are different workflows. Do not call WhatsApp device tools for Telegram tasks.",
  );
  parts.push(
    "If the user mentions Telegram, Telegram bot, BotFather, bot token, adminTelegramIds, or Telegram chat ID, use Telegram tools (`setup_telegram_bot`, `configure_telegram_admins`, `get_telegram_bot_status`) and never use `add_device` unless the user separately asks for WhatsApp.",
  );
  parts.push(
    "If the user mentions WhatsApp device, WA device, QR scan, session pairing, or phone number connection, use `add_device`. If the channel is unclear, ask one short clarification question before calling tools.",
  );
  parts.push(
    "1. Plan Ahead: If a task requires multiple steps, mention your plan briefly before calling the first tool.",
  );
  parts.push(
    "2. Coding & Scaffolding: For ANY coding task (create project, add features, fix bugs, scaffold files), use 'run_code_agent' first. If the agent cannot complete the task, you may fallback to other tools.",
  );
  parts.push(
    "3. Fail-Soft: If the code agent fails or cannot fulfill a specific requirement, only then fallback to 'run_terminal' for manual corrections.",
  );
  parts.push(
    "4. Workspace Management: All user projects must be created and managed inside the workspaces directory (resolved as ${workspacesDir}). Use relative paths in 'cwd' to work inside project folders.",
  );
  parts.push(
    "5. Iteration: Analyze tool results. If a command fails, describe why in prose and try a different approach.",
  );
  parts.push(
    "6. WhatsApp Automation: Use `add_device` only for WhatsApp devices/sessions. When adding a new WhatsApp device with `add_device`, the tool will automatically handle session connection, QR code generation, and wait for the user to scan. Once the tool returns successfully, the device is ALREADY connected and sync is complete. You MUST NOT ask the user to connect or scan again. Simply confirm the connection and ask what to do next.",
  );
  parts.push(
    "7. AI Provider Setup: If no AI provider is configured, ask the user for the provider name, API key, and desired model. Use `add_llm_provider` to save the provider, then persist defaults with `set_default_ai_provider`, `set_default_ai_model`, or `set_ai_defaults`.",
  );
  parts.push(
    "8. Telegram Setup: If the user asks to set up Telegram, do not create a WhatsApp session and do not show a WhatsApp QR. Ask the user to create a bot with BotFather and paste the bot token. Use `setup_telegram_bot` with the token to start the bot. If they want access restricted, configure admin Telegram IDs later with `configure_telegram_admins`.",
  );
  parts.push(
    "9. API Gateway Setup: If the user wants OpenWA to integrate with an external CRM, ERP, helpdesk, or app as a messaging gateway, ask for the external webhook URL and shared webhook secret if missing. Use `setup_gateway_integration` to set the webhook, create an API key for the external app, and turn internal CRM automation off. Tell the user the returned API key secret is shown only once and must be saved in the external app.",
  );
  parts.push("");
  parts.push(`Available tools: ${toolsList}.`);
  parts.push("");
  parts.push(`TOOLS.md:\n${toolsText}`);
  parts.push("");
  parts.push(`OpenAPI doc (JSON):\n${openapiText}`);
  parts.push("");
  parts.push(
    `When you want to execute a tool, respond with a JSON object. Example: {"tool":"run_code_agent","args":{"prompt":"create a nextjs app with tailwind","cwd":"my-app"}}.`,
  );

  return parts.filter(Boolean).join("\n");
}
function normalizeAssistantInput(input) {
  if (typeof input === "string") {
    return {
      body: input,
      type: "text",
      mediaFileId: null,
      replyToId: null,
    };
  }

  const payload = input && typeof input === "object" ? input : {};
  return {
    body: String(payload.body || ""),
    type: payload.type || (payload.mediaFileId ? "document" : "text"),
    mediaFileId: payload.mediaFileId || null,
    replyToId: payload.replyToId || null,
  };
}

async function loadAssistantMediaFile(userId, mediaFileId) {
  if (!mediaFileId) return null;
  return prisma.mediaFile.findFirst({
    where: {
      id: mediaFileId,
      userId,
    },
  });
}

function buildMessageContentForLLM(message) {
  const body = String(message?.body || "").trim();
  const mediaFile = message?.mediaFile || null;
  if (!mediaFile) return body;

  const attachmentText = `[attachment already uploaded: ${mediaFile.originalName || "file"}; mimeType: ${mediaFile.mimeType || "unknown"}; relativePath: ${mediaFile.relativePath || "unknown"}]`;
  return body ? `${body}\n${attachmentText}` : attachmentText;
}

function isImageMediaFile(mediaFile) {
  return Boolean(
    mediaFile &&
    String(mediaFile.mimeType || "")
      .toLowerCase()
      .startsWith("image/"),
  );
}

function isVisionCapableProvider(providerName) {
  const normalized = String(providerName || "").toLowerCase();
  return normalized === "openai" || normalized === "openrouter";
}

function resolveMediaFilePath(mediaFile) {
  const relativePath = String(mediaFile?.relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!relativePath) return null;
  const normalized = relativePath.startsWith("media/")
    ? relativePath.slice("media/".length)
    : relativePath;
  return path.join(mediaDir, normalized);
}

function buildAssistantAttachmentInstruction(body, mediaFile) {
  const attachmentText = buildMessageContentForLLM({ body, mediaFile });
  return body
    ? `User attached a file to this message. The file is already uploaded in the current chat and does not need to be re-uploaded. Caption or question: ${body}\n${attachmentText}`
    : `User attached a file to this message. The file is already uploaded in the current chat and does not need to be re-uploaded. ${attachmentText}`;
}

function buildVisionUserContent(body, mediaFile) {
  const filePath = resolveMediaFilePath(mediaFile);
  if (!filePath || !fs.existsSync(filePath)) {
    return buildAssistantAttachmentInstruction(body, mediaFile);
  }

  const maxInlineBytes = 5 * 1024 * 1024;
  if (mediaFile?.size && Number(mediaFile.size) > maxInlineBytes) {
    return buildAssistantAttachmentInstruction(body, mediaFile);
  }

  const base64 = fs.readFileSync(filePath).toString("base64");
  const blocks = [];
  const instruction = body
    ? `User attached this image and asked: ${body}. Analyze the attached image directly.`
    : "User attached this image. Analyze the attached image directly.";

  blocks.push({ type: "text", text: instruction });
  blocks.push({
    type: "image_url",
    image_url: {
      url: `data:${mediaFile.mimeType || "image/png"};base64,${base64}`,
    },
  });

  return blocks;
}

function buildLlmUserContent({ body, mediaFile, providerName }) {
  if (!mediaFile) {
    return String(body || "").trim();
  }

  if (isImageMediaFile(mediaFile) && isVisionCapableProvider(providerName)) {
    return buildVisionUserContent(body, mediaFile);
  }

  return buildAssistantAttachmentInstruction(body, mediaFile);
}

function buildUserRequestSummaryText({ body, mediaFile }) {
  return (
    buildAssistantAttachmentInstruction(body, mediaFile) ||
    String(body || "").trim() ||
    "User sent an attachment."
  );
}

function formatLlmErrorForUser(error) {
  const message = String(error?.message || error || "");
  console.error("[Assistant LLM Error]:", error);

  if (!message) {
    return "Model AI sedang bermasalah. Coba kirim lagi beberapa saat lagi.";
  }

  // Show detailed error message so user can understand if it's a context window or API limit issue
  return `Model AI gagal memproses permintaan. Detail: ${message}`;
}

function buildToolResultFallbackText(toolName, toolResult) {
  if (toolName === "run_terminal" && toolResult?.executed) {
    return "Perintah berhasil dijalankan.";
  }

  if (toolResult?.ok === true) {
    return `Tool ${toolName} berhasil dijalankan.`;
  }

  return `Tool ${toolName} executed. Result: ${JSON.stringify(toolResult)}`;
}

async function storeAssistantTerminalMessage({
  userId,
  chatId,
  assistantSender,
  assistantDisplayName,
  command,
  terminalId,
  executed,
  io,
  toolName,
}) {
  const typeLabel = toolName === "run_code_agent" ? "CodeAgent" : "Terminal";
  const body = executed
    ? `${typeLabel} command finished: ${command}`
    : `${typeLabel} command pending approval: ${command}`;

  const assistantMsg = chatId
    ? await chatService.storeIncomingMessageInChat({
        userId,
        chatId,
        sender: assistantSender,
        body,
        externalMessageId: `terminal:${terminalId}`,
      })
    : await chatService.storeIncomingMessage({
        userId,
        sessionId: null,
        sender: assistantSender,
        displayName: assistantDisplayName,
        body,
        externalMessageId: `terminal:${terminalId}`,
      });

  try {
    io && io.to(`user:${userId}`).emit("new_message", assistantMsg.message);
    io &&
      io.to(`user:${userId}`).emit("contact_list_update", assistantMsg.chat);
  } catch (e) {
    // ignore emit errors
  }
}

function getTerminalCommandForTool(toolName, args, toolResult) {
  if (!toolResult?.id) return null;

  if (toolName === "run_terminal") {
    return String(args?.command || toolResult?.command || "").trim() || null;
  }

  if (toolName === "run_code_agent") {
    return String(toolResult?.command || "").trim() || null;
  }

  return null;
}

const tools = {
  add_device: async (userId, args, ctx) => {
    const name = String(args.name || "").trim();
    const phoneNumber = args.phoneNumber || null;
    const rawArgs = JSON.stringify(args || {}).toLowerCase();
    if (/\btelegram\b|botfather|telegram_bot|bot token/.test(rawArgs)) {
      throw new Error(
        "This is a Telegram setup request. Use setup_telegram_bot instead of add_device. add_device is only for WhatsApp sessions.",
      );
    }
    if (!name) throw new Error("name is required");
    const { sessionManager, io, chatId } = ctx || {};
    if (!sessionManager) throw new Error("sessionManager not found in context");

    // Check if a session with the same name already exists for this user
    const existingSessions = await sessionService.listUserSessions(userId);
    const existing = existingSessions.find(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    );

    let session;
    if (existing) {
      // If it exists and is already ready or connecting, just reuse it
      if (existing.status === "ready" || existing.status === "connecting") {
        return {
          ok: true,
          session: existing,
          status: existing.status,
          summary: `WhatsApp device "${name}" is already ${existing.status}. No need to create a new one.`,
        };
      }
      session = existing;
    } else {
      session = await sessionService.createUserSession(userId, {
        name,
        phoneNumber: phoneNumber || null,
      });
    }

    const assistantSender = "openwa:assistant";
    const assistantDisplayName = "OpenWA Assistant";

    // Only create a companion chat if we're not already in an assistant chat,
    // or if the user specifically requested it (though currently we just default to not
    // spamming new chats if we have a chatId).
    if (!chatId) {
      try {
        await chatService.createSessionCompanionChat(userId, session);
      } catch (e) {
        // ignore companion chat errors
      }
    }

    return new Promise(async (resolve, reject) => {
      let qrSent = false;
      let syncFinished = false;
      const timeoutSeconds = 180;
      const timeout = setTimeout(() => {
        sessionManager.removeListener("session-status", onStatus);
        sessionManager.removeListener("workspace-sync", onSync);
        resolve({
          ok: false,
          error:
            "Connection timed out after 3 minutes. Please try again or check the Sessions settings.",
          session,
        });
      }, timeoutSeconds * 1000);

      const onSync = (payload) => {
        if (payload.sessionId === session.id) {
          syncFinished = true;
        }
      };

      const onStatus = async (payload) => {
        if (payload.sessionId !== session.id) return;

        // If we get a QR code and haven't sent it to this chat yet, send it
        if (payload.qrCode && !qrSent && chatId) {
          qrSent = true;
          try {
            // Convert data URL to buffer and save as media file
            const base64Data = payload.qrCode.split(",")[1];
            if (base64Data) {
              const buffer = Buffer.from(base64Data, "base64");
              const filename = `qr-${session.id}-${Date.now()}.png`;
              const filePath = path.join(mediaDir, filename);

              if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
              }
              fs.writeFileSync(filePath, buffer);

              const mediaFile = await prisma.mediaFile.create({
                data: {
                  userId,
                  fileName: filename,
                  originalName: "whatsapp-qr.png",
                  mimeType: "image/png",
                  size: buffer.length,
                  relativePath: `media/${filename}`,
                },
              });

              await sendAssistantMessage(
                userId,
                assistantSender,
                assistantDisplayName,
                `Please scan this QR code with your WhatsApp mobile app to connect the device "${name}".`,
                io,
                chatId,
                mediaFile.id,
              );
            }
          } catch (err) {
            console.error("[add_device] Failed to send QR to chat:", err);
          }
        }

        if (payload.status === "ready") {
          // If there's a lastError (like sync failed), we should still report success but mention the error
          const hasSyncError =
            payload.lastError && payload.lastError.includes("sync failed");

          // Wait a bit for sync to finish if it hasn't yet, or just proceed
          // since SessionManager handles sync asynchronously.
          // But to be sure, we can wait up to 10 seconds for the sync event.
          let syncWaitCount = 0;
          while (!syncFinished && syncWaitCount < 20 && !hasSyncError) {
            await new Promise((r) => setTimeout(r, 500));
            syncWaitCount++;
          }

          clearTimeout(timeout);
          sessionManager.removeListener("session-status", onStatus);
          sessionManager.removeListener("workspace-sync", onSync);

          if (chatId) {
            const successMsg = hasSyncError
              ? `✅ WhatsApp device "${name}" is connected, but I encountered a temporary issue syncing your old chats. Your new messages will still work perfectly!`
              : `✅ WhatsApp device "${name}" is now connected and ready! I have fetched your recent chats and contacts.`;

            await sendAssistantMessage(
              userId,
              assistantSender,
              assistantDisplayName,
              successMsg,
              io,
              chatId,
            );
          }

          resolve({
            ok: true,
            session,
            status: "ready",
            summary: `WhatsApp device "${name}" is now fully connected. ${hasSyncError ? "Initial sync had some issues but connection is active." : "User has already scanned the QR code."} You do NOT need to ask for connection again.`,
          });
        }

        if (payload.status === "error") {
          clearTimeout(timeout);
          sessionManager.removeListener("session-status", onStatus);
          sessionManager.removeListener("workspace-sync", onSync);
          resolve({
            ok: false,
            error: payload.lastError || "Failed to connect WhatsApp session.",
            session,
          });
        }
      };

      sessionManager.on("session-status", onStatus);
      sessionManager.on("workspace-sync", onSync);

      try {
        await sessionManager.connectSession(userId, session.id, {
          force: true,
        });
      } catch (e) {
        clearTimeout(timeout);
        sessionManager.removeListener("session-status", onStatus);
        reject(e);
      }
    });
  },
  add_llm_provider: async (userId, args) => {
    const provider = String(args.provider || "").toLowerCase();
    const name = String(args.name || provider || "Provider");
    const cfg = Object.assign({}, args.config || {});
    if (args.host) {
      cfg.host = String(args.host || "").trim();
    }
    const created = await aiProviderService.createProvider(userId, {
      provider,
      name,
      config: cfg,
    });
    return { ok: true, provider: created };
  },
  set_default_ai_provider: async (userId, args) => {
    const providerId = String(
      args.providerId || args.id || args.provider || "",
    ).trim();
    if (!providerId) throw new Error("providerId is required.");

    const provider = await aiProviderService.getProvider(userId, providerId);
    if (!provider) throw new Error("AI provider not found.");

    await userSettings.setSetting(userId, "defaultAiProviderId", providerId);
    return {
      ok: true,
      defaultAiProviderId: providerId,
      message: `Default AI provider set to ${provider.name}.`,
    };
  },
  set_default_ai_model: async (userId, args) => {
    const model = String(
      args.model || args.defaultModel || args.defaultAiModel || "",
    ).trim();
    if (!model) throw new Error("model is required.");

    await userSettings.setSetting(userId, "defaultAiModel", model);
    return {
      ok: true,
      defaultAiModel: model,
      message: `Default AI model set to ${model}.`,
    };
  },
  set_ai_defaults: async (userId, args) => {
    const providerId = String(
      args.providerId || args.id || args.provider || "",
    ).trim();
    const model = String(
      args.model || args.defaultModel || args.defaultAiModel || "",
    ).trim();
    if (!providerId && !model) {
      throw new Error("At least one of providerId or model is required.");
    }

    const result = { ok: true, updated: {} };

    if (providerId) {
      const provider = await aiProviderService.getProvider(userId, providerId);
      if (!provider) throw new Error("AI provider not found.");
      await userSettings.setSetting(userId, "defaultAiProviderId", providerId);
      result.updated.defaultAiProviderId = providerId;
      result.updated.message = `Default AI provider set to ${provider.name}.`;
    }

    if (model) {
      await userSettings.setSetting(userId, "defaultAiModel", model);
      result.updated.defaultAiModel = model;
      result.updated.message = `Default AI model set to ${model}.`;
    }

    return {
      ok: true,
      ...result,
    };
  },
  get_default_ai_provider: async (userId) => {
    const providerId = await userSettings.getSetting(
      userId,
      "defaultAiProviderId",
    );
    const defaultAiModel = await userSettings.getSetting(
      userId,
      "defaultAiModel",
    );

    let provider = null;
    if (providerId) {
      provider = await aiProviderService.getProvider(userId, providerId);
      if (provider) {
        provider = {
          id: provider.id,
          provider: provider.provider,
          name: provider.name,
          config: {
            host: provider.config?.host || null,
          },
        };
      }
    }

    return {
      ok: true,
      defaultAiProviderId: providerId || null,
      defaultAiModel: defaultAiModel || null,
      provider,
    };
  },
  update_assistant: async (userId, args) => {
    const { displayName, avatarUrl, persona } = args || {};
    const updated = await assistantService.updateAssistant(userId, {
      displayName,
      avatarUrl,
      persona,
    });
    return { ok: true, assistant: updated };
  },
  create_api_key: async (userId, args) => {
    const name = String(args.name || `agent-${Date.now()}`);
    const result = await apiKeyService.createApiKey(userId, { name });
    return { ok: true, apiKey: result };
  },
  update_webhook: async (userId, args) => {
    const { url, apiKey } = args || {};
    if (!url) throw new Error("url is required");
    const cfg = webhookService.setWebhook(userId, { url, apiKey });
    return { ok: true, webhook: cfg };
  },
  setup_gateway_integration: async (userId, args = {}) => {
    const url = String(args.url || args.webhookUrl || "").trim();
    if (!url) throw new Error("webhook url is required.");

    try {
      new URL(url);
    } catch (error) {
      throw new Error("webhook url must be a valid URL.");
    }

    const webhookKey = String(
      args.apiKey || args.webhookApiKey || args.webhookKey || args.secret || "",
    ).trim();
    const externalAppName = String(
      args.name || args.appName || args.externalAppName || "External Gateway",
    ).trim();
    const createApiKey = args.createApiKey !== false;
    const disableInternalCrm = args.disableInternalCrm !== false;

    const webhook = webhookService.setWebhook(userId, {
      url,
      apiKey: webhookKey,
    });

    let crmSettings = null;
    if (disableInternalCrm) {
      crmSettings = await crmService.updateSettings(userId, {
        defaultMode: "off",
      });
    }

    let apiKey = null;
    if (createApiKey) {
      const result = await apiKeyService.createApiKey(userId, {
        name: `${externalAppName} API Gateway`,
      });
      apiKey = result;
    }

    return {
      ok: true,
      webhook,
      apiKey,
      crmDefaultMode: crmSettings?.defaultMode || null,
      docs: {
        readme: "/docs/readme#webhooks",
        openapi: "/docs/json",
      },
      message:
        "OpenWA gateway integration is configured. Save the API key secret in the external app; it is shown only once. The external app should verify x-openwa-webhook-key, store chat.id, and reply through POST /api/chats/{chatId}/messages/send.",
    };
  },
  run_terminal: async (userId, args, ctx) => {
    const {
      command,
      approvalMode,
      timeout = 600000,
      trustedAuto,
      cwd,
    } = args || {};
    if (!command) throw new Error("command is required");

    // Default to workspacesDir if no relative cwd provided, or resolve relative to workspacesDir
    let effectiveCwd = workspacesDir;
    if (cwd) {
      // Normalize 'workspaces' as relative cwd to just be the root
      const normalizedCwd = String(cwd)
        .trim()
        .replace(/^[\\\/]+|[\\\/]+$/g, "");
      if (normalizedCwd === "workspaces") {
        effectiveCwd = workspacesDir;
      } else {
        effectiveCwd = path.isAbsolute(cwd)
          ? cwd
          : path.join(workspacesDir, cwd);
      }
    }
    ensureDir(effectiveCwd);

    // If the user has enabled auto-approve in settings, prefer auto when
    // approvalMode isn't explicitly set to 'manual'. This ensures server-side
    // agent invocations follow the user's toggle.
    let effectiveApprovalMode = approvalMode;
    try {
      const pref = await userSettings.getSetting(
        userId,
        "autoApproveAllTerminalCommands",
      );
      if (!effectiveApprovalMode && pref) effectiveApprovalMode = "auto";
    } catch (e) {
      // ignore and fallback to provided/default
    }

    // Pass socket/io so terminal-service can emit request/result events
    const res = await terminalService.requestExecution(
      userId,
      {
        command,
        approvalMode: effectiveApprovalMode,
        timeout,
        trustedAuto: !!trustedAuto,
        chatId: ctx?.chatId || null,
        cwd: effectiveCwd,
      },
      ctx && ctx.io,
    );
    return res;
  },
  run_code_agent: async (userId, args, ctx) => {
    // LLM-driven local coding agent: use the orchestrator to plan and execute
    // coding tasks. Accepts { prompt, cwd, maxSteps }.
    const prompt = String(args.prompt || args.command || "").trim();
    if (!prompt) throw new Error("prompt is required");
    const maxSteps = Number(args.maxSteps) || 6;

    const orchesRes = await orchestrator.orchestrate({
      userId,
      message: prompt,
      context: Object.assign({}, ctx, { cwd: args && args.cwd }),
      maxSteps,
    });

    if (!orchesRes || !orchesRes.success) {
      return {
        ok: false,
        error:
          orchesRes && orchesRes.error
            ? orchesRes.error
            : "orchestrator_failed",
        result: orchesRes,
      };
    }

    return {
      ok: true,
      command: null,
      id: null,
      executed: true,
      result: orchesRes,
    };
  },
  search_messages: async (userId, args) => {
    const q = String(args.q || "").trim();
    if (!q) throw new Error("q is required");
    const chatId = args.chatId || null;
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));

    const where = {
      AND: [
        { chat: { userId } },
        ...(chatId ? [{ chatId }] : []),
        {
          OR: [
            { body: { contains: q } },
            { sender: { contains: q } },
            { mediaFile: { originalName: { contains: q } } },
            { mediaFile: { fileName: { contains: q } } },
          ],
        },
      ],
    };

    const results = await prisma.message.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        mediaFile: true,
        chat: { include: { contact: true } },
        replyTo: { include: { mediaFile: true } },
        statuses: true,
      },
    });

    return {
      ok: true,
      count: results.length,
      messages: results.map((m) => ({
        id: m.id,
        chatId: m.chatId,
        chatTitle: m.chat?.title || null,
        contact: m.chat?.contact
          ? {
              id: m.chat.contact.id,
              displayName: m.chat.contact.displayName,
              externalId: m.chat.contact.externalId,
            }
          : null,
        sender: m.sender,
        body: m.body,
        type: m.type,
        createdAt: m.createdAt,
        mediaFile: m.mediaFile
          ? {
              id: m.mediaFile.id,
              originalName: m.mediaFile.originalName,
              mimeType: m.mediaFile.mimeType,
              relativePath: m.mediaFile.relativePath,
            }
          : null,
      })),
    };
  },
  register_tool: async (userId, args) => {
    const manifest = args.manifest || args || {};
    const overwrite = Boolean(args.overwrite);
    const res = await registerExternalTool(userId, manifest, { overwrite });

    // If apiKey provided with direct manifest registration, save it for caller
    if (args.apiKey) {
      try {
        await toolCredentialService.saveCredential(userId, res.tool.id, {
          apiKey: args.apiKey,
          headerName: args.headerName || "Authorization",
        });
        res.credentialSaved = true;
      } catch (e) {
        res.credentialSaved = false;
        res.credentialError = String(e && e.message ? e.message : e);
      }
    }

    return res;
  },
  register_tool_from_url: async (userId, args) => {
    const url = args.url || args.manifestUrl || args.link;
    const apiKey = args.apiKey || args.key || null;
    const headerName = args.headerName || null;
    const overwrite = Boolean(args.overwrite);
    const res = await fetchAndRegisterTool(userId, {
      url,
      apiKey,
      headerName,
      overwrite,
    });
    return res;
  },
  list_workspaces: async (userId, args) => {
    ensureDir(workspacesDir);
    const items = fs.readdirSync(workspacesDir);
    const stats = items.map((name) => {
      const fullPath = path.join(workspacesDir, name);
      const s = fs.statSync(fullPath);
      return {
        name,
        isDirectory: s.isDirectory(),
        size: s.size,
        updatedAt: s.mtime,
      };
    });
    return { ok: true, workspacesPath: workspacesDir, items: stats };
  },
  invoke_registered_tool: async (userId, args, ctx) => {
    const toolId = args.id || args.toolId || args.name;
    if (!toolId) throw new Error("tool id is required");
    const options = args.options || args || {};
    const res = await invokeRegisteredTool(userId, toolId, options, ctx);
    return { ok: true, result: res };
  },
  update_tools_md: async (userId, args) => {
    const { action, content } = args || {};
    await updateToolsFile({
      action: action || "append",
      content: content || "",
    });
    return { ok: true };
  },
  get_webpage: async (userId, args) => {
    const url = String(args.url || args.link || "").trim();
    if (!url) throw new Error("url is required");
    const result = await fetchWebpage(url);
    if (!result.ok) {
      // Fallback to openBrowser if fetch fails (could be JS-heavy)
      return await openBrowser(url);
    }
    return { ok: true, content: (result.body || "").substring(0, 30000) };
  },
  open_browser: async (userId, args) => {
    const url = String(args.url || args.link || "").trim();
    if (!url) throw new Error("url is required");
    const result = await openBrowser(url);
    return result;
  },
  setup_telegram_bot: async (userId, args) => {
    const token = String(args.token || args.botToken || "").trim();
    if (!token) throw new Error("Telegram Bot Token is required.");

    const adminIdsArg =
      args.adminTelegramIds || args.adminIds || args.admin || [];
    const normalizedAdminIds = Array.isArray(adminIdsArg)
      ? adminIdsArg.map((v) => String(v).trim()).filter(Boolean)
      : String(adminIdsArg)
          .split(/[,;\s]+/)
          .map((v) => String(v).trim())
          .filter(Boolean);

    // Validate token by starting the bot
    try {
      await TelegramService.startBot(userId, token);
    } catch (err) {
      throw new Error(
        `Failed to start Telegram Bot: ${err.message}. Please check your token.`,
      );
    }

    // Save token securely
    await toolCredentialService.saveCredential(userId, "telegram_bot", {
      apiKey: token,
      headerName: "X-Telegram-Bot-Token",
    });

    if (normalizedAdminIds.length > 0) {
      TelegramConfigService.saveConfig(userId, {
        adminTelegramIds: normalizedAdminIds,
      });
    }

    return {
      ok: true,
      message:
        normalizedAdminIds.length > 0
          ? `Telegram Bot is running now, and the authorized Telegram chat IDs have been saved: ${normalizedAdminIds.join(", ")}. You can now control OpenWA using the bot from those chats.`
          : "Telegram Bot is running now, and the token has been saved. You can now remote OpenWA via your Telegram bot. If you want to restrict access later, send the admin chat IDs using configure_telegram_admins.",
      adminTelegramIds: normalizedAdminIds,
    };
  },
  configure_telegram_admins: async (userId, args) => {
    const adminIdsArg =
      args.adminTelegramIds || args.adminIds || args.admin || [];
    const normalizedAdminIds = Array.isArray(adminIdsArg)
      ? adminIdsArg.map((v) => String(v).trim()).filter(Boolean)
      : String(adminIdsArg)
          .split(/[,;\s]+/)
          .map((v) => String(v).trim())
          .filter(Boolean);

    if (normalizedAdminIds.length === 0) {
      throw new Error(
        "adminTelegramIds is required and must contain at least one Telegram chat ID.",
      );
    }

    const savedConfig = TelegramConfigService.saveConfig(userId, {
      adminTelegramIds: normalizedAdminIds,
    });
    return {
      ok: true,
      adminTelegramIds: savedConfig.adminTelegramIds,
      message: `Telegram admin chat IDs have been saved: ${savedConfig.adminTelegramIds.join(", ")}.`,
    };
  },
  get_telegram_bot_status: async (userId) => {
    const savedToken = await toolCredentialService.getCredentialForUser(
      userId,
      "telegram_bot",
    );
    const isRunning = TelegramService.isBotRunning(userId);
    return {
      ok: true,
      botConfigured: Boolean(savedToken && savedToken.apiKey),
      botRunning: isRunning,
      message: isRunning
        ? "Telegram bot is currently running."
        : savedToken && savedToken.apiKey
          ? "Telegram bot is configured but not currently running. Restart the OpenWA process to launch it, or call setup_telegram_bot again."
          : "Telegram bot has not been configured yet.",
    };
  },
};

// Invoke a registered tool by id. Supports HTTP and OpenAPI-backed tools.
async function invokeRegisteredTool(userId, toolId, options = {}, ctx = {}) {
  const registryPath = path.join(storageDir, "tools_registry.json");
  if (!fs.existsSync(registryPath)) throw new Error("tools registry not found");
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8") || "{}");
  } catch (e) {
    throw new Error("failed to read tools registry");
  }

  const entry = registry[toolId];
  if (!entry) throw new Error(`tool not found: ${toolId}`);

  // Authorization: allow if the invoking user added the tool or the tool has invokeEnabled
  if (entry.addedBy !== userId && !entry.invokeEnabled) {
    throw new Error("not authorized to invoke this tool");
  }

  // Resolve base URL
  let baseUrl = null;
  if (entry.invoke && /^https?:\/\//i.test(String(entry.invoke))) {
    baseUrl = String(entry.invoke);
  } else if (
    String(entry.invoke) === "openapi" &&
    entry.docs &&
    /^https?:\/\//i.test(String(entry.docs))
  ) {
    try {
      const openapiResp = await fetch(String(entry.docs));
      const doc = await openapiResp.json().catch(() => null);
      if (
        doc &&
        Array.isArray(doc.servers) &&
        doc.servers[0] &&
        doc.servers[0].url
      ) {
        baseUrl = String(doc.servers[0].url);
      } else {
        baseUrl = new URL(entry.docs).origin;
      }
    } catch (e) {
      baseUrl = new URL(entry.docs).origin;
    }
  } else if (entry.docs && /^https?:\/\//i.test(String(entry.docs))) {
    // fallback to docs origin
    baseUrl = new URL(entry.docs).origin;
  }

  if (!baseUrl)
    throw new Error("cannot determine base URL for tool invocation");

  const method = (options.method || options.verb || "GET").toUpperCase();
  const pathOrUrl = options.url || options.path || "/";
  let targetUrl;
  try {
    targetUrl = /^https?:\/\//i.test(String(pathOrUrl))
      ? String(pathOrUrl)
      : new URL(pathOrUrl, baseUrl).toString();
  } catch (e) {
    throw new Error("invalid target path/url");
  }

  // If caller did not provide an apiKey in options, try to load a stored credential
  if (!options.apiKey) {
    try {
      const cred = await toolCredentialService.getCredentialForUser(
        userId,
        toolId,
      );
      if (cred && cred.apiKey) {
        options.apiKey = cred.apiKey;
        options.headerName =
          options.headerName || cred.headerName || "Authorization";
      }
    } catch (e) {
      // ignore credential errors and proceed without stored apiKey
    }
  }

  const headers = Object.assign({}, options.headers || {});
  // support passing apiKey in options
  if (options.apiKey) {
    const hn = options.headerName || "Authorization";
    headers[hn] =
      hn.toLowerCase() === "authorization" &&
      !/^\s*Bearer\s+/i.test(options.apiKey)
        ? `Bearer ${options.apiKey}`
        : options.apiKey;
  }

  // Add meta headers
  headers["x-openwa-tool-id"] = toolId;
  headers["x-openwa-user-id"] = userId;

  // Append query params
  if (options.params && typeof options.params === "object") {
    const u = new URL(targetUrl);
    Object.entries(options.params || {}).forEach(([k, v]) =>
      u.searchParams.append(k, String(v)),
    );
    targetUrl = u.toString();
  }

  // Body handling
  let body = undefined;
  if (
    options.body !== undefined &&
    options.body !== null &&
    method !== "GET" &&
    method !== "HEAD"
  ) {
    if (typeof options.body === "object" && !(options.body instanceof Buffer)) {
      body = JSON.stringify(options.body);
      headers["content-type"] = headers["content-type"] || "application/json";
    } else {
      body = options.body;
    }
  }

  // Timeout support
  const timeout = Number(options.timeout) || 0;
  let controller;
  let signal = undefined;
  if (timeout > 0) {
    controller = new AbortController();
    signal = controller.signal;
    setTimeout(() => controller.abort(), timeout);
  }

  let resp;
  try {
    resp = await fetch(targetUrl, {
      method,
      headers,
      body,
      signal,
      redirect: "follow",
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("request timed out");
    throw new Error(`request failed: ${err.message}`);
  }

  const headersObj = {};
  for (const [k, v] of resp.headers) headersObj[k] = v;

  const rawText = await resp.text().catch(() => "");
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    parsed = null;
  }

  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers: headersObj,
    body: parsed !== null ? parsed : rawText,
    rawBody: rawText,
  };
}

async function handleAssistantMessage(userId, chatId, input, ctx = {}) {
  ctx = Object.assign({ chatId }, ctx || {});
  const { config, io, socket, sessionManager } = ctx;
  const assistantInput = normalizeAssistantInput(input);
  const mediaFile = await loadAssistantMediaFile(
    userId,
    assistantInput.mediaFileId,
  );

  const incomingText = String(assistantInput.body || "").trim();
  const pendingReset = getPendingPasswordReset(userId, chatId);
  const newPassword = parseNewPasswordCommand(incomingText);

  if (isCancelResetPassword(incomingText) && pendingReset) {
    clearPendingPasswordReset(userId, chatId);
    await sendAssistantMessage(
      userId,
      "openwa:assistant",
      "OpenWA Assistant",
      "Password reset cancelled. If you want to reset again, send /reset_password.",
      io,
      chatId,
    );
    return;
  }

  if (pendingReset && newPassword) {
    try {
      await authService.resetPasswordById({
        userId,
        password: newPassword,
      });
      clearPendingPasswordReset(userId, chatId);
      await sendAssistantMessage(
        userId,
        "openwa:assistant",
        "OpenWA Assistant",
        "✅ Password berhasil direset. Anda sekarang bisa login dengan kata sandi baru tersebut.",
        io,
        chatId,
      );
    } catch (error) {
      await sendAssistantMessage(
        userId,
        "openwa:assistant",
        "OpenWA Assistant",
        `Gagal mereset password: ${error.message}`,
        io,
        chatId,
      );
    }
    return;
  }

  if (pendingReset) {
    await sendAssistantMessage(
      userId,
      "openwa:assistant",
      "OpenWA Assistant",
      "Silakan kirim /new_password <kata sandi baru> atau ketik /cancel_reset untuk membatalkan.",
      io,
      chatId,
    );
    return;
  }

  if (isResetPasswordTrigger(incomingText)) {
    setPendingPasswordReset(userId, chatId);
    await sendAssistantMessage(
      userId,
      "openwa:assistant",
      "OpenWA Assistant",
      "Silakan kirim `/new_password <kata sandi baru>` untuk mereset password akun OpenWA ini.",
      io,
      chatId,
    );
    return;
  }
  const llmUserMessage = buildMessageContentForLLM({
    body: assistantInput.body,
    mediaFile,
  });

  // store user's outgoing message (so it appears in conversation)
  const userResult = await chatService.createOutgoingMessage({
    userId,
    chatId,
    body: assistantInput.body,
    type: assistantInput.type,
    mediaFileId: assistantInput.mediaFileId,
    replyToId: assistantInput.replyToId,
  });
  const assistantSender =
    (userResult && userResult.message && userResult.message.receiver) ||
    "openwa:assistant";
  const chatContact = userResult?.chat?.contact || null;
  const isTelegramRemoteAssistant = String(
    chatContact?.externalId || assistantSender || "",
  ).startsWith("tg:");
  const assistantDisplayName =
    !isTelegramRemoteAssistant && chatContact?.displayName
      ? chatContact.displayName
      : "OpenWA Assistant";
  try {
    io.to(`user:${userId}`).emit("new_message", userResult.message);
    io.to(`user:${userId}`).emit("contact_list_update", userResult.chat);
  } catch (e) {
    // ignore emit errors
  }

  let chatSummary = null;
  if (chatId) {
    try {
      chatSummary = await chatService.getChatWithContact(userId, chatId);
    } catch (e) {
      chatSummary = null;
    }
  }

  const directToolCall = resolveDirectAssistantToolCall(
    assistantInput.body,
    ctx,
  );

  // Prepare context for LLM only when needed.
  let providerId = null;
  let providerName = null;
  if (!directToolCall) {
    providerId = await chooseProviderId(userId);
    if (!providerId) {
      const setupInfo = parseProviderSetupInput(assistantInput.body);
      if (setupInfo) {
        try {
          const created = await aiProviderService.createProvider(userId, {
            provider: setupInfo.provider,
            name: setupInfo.name,
            config: setupInfo.config,
          });
          await userSettings.setSetting(
            userId,
            "defaultAiProviderId",
            created.id,
          );
          if (setupInfo.defaultModel) {
            await userSettings.setSetting(
              userId,
              "defaultAiModel",
              setupInfo.defaultModel,
            );
          }

          const body =
            `AI provider configured successfully. Provider '${created.name}' is now set as the default.` +
            (setupInfo.defaultModel
              ? ` Default model '${setupInfo.defaultModel}' is saved.`
              : "");
          const assistantMsg = await chatService.storeIncomingMessage({
            userId,
            sessionId: null,
            sender: assistantSender,
            displayName: assistantDisplayName,
            body,
          });
          io.to(`user:${userId}`).emit("new_message", assistantMsg.message);
          io.to(`user:${userId}`).emit(
            "contact_list_update",
            assistantMsg.chat,
          );
          return;
        } catch (err) {
          const assistantMsg = await chatService.storeIncomingMessage({
            userId,
            sessionId: null,
            sender: assistantSender,
            displayName: assistantDisplayName,
            body: `Failed to configure AI provider: ${err.message}`,
          });
          io.to(`user:${userId}`).emit("new_message", assistantMsg.message);
          io.to(`user:${userId}`).emit(
            "contact_list_update",
            assistantMsg.chat,
          );
          return;
        }
      }

      const help =
        'No AI provider configured. Please set up a provider using the following JSON format in chat:\n```json\n{\n  "provider": "openai",\n  "name": "OpenAI",\n  "config": {\n    "apiKey": "sk-...",\n    "host": "https://api.openai.com"\n  },\n  "defaultModel": "gpt-5-mini"\n}\n```\nIf you prefer, just ask me to configure the provider and I will guide you step by step.';
      const assistantMsg = await chatService.storeIncomingMessage({
        userId,
        sessionId: null,
        sender: assistantSender,
        displayName: assistantDisplayName,
        body: help,
      });
      io.to(`user:${userId}`).emit("new_message", assistantMsg.message);
      io.to(`user:${userId}`).emit("contact_list_update", assistantMsg.chat);
      return;
    }

    try {
      const provider = await aiProviderService.getProvider(userId, providerId);
      providerName = provider?.provider || null;
    } catch (e) {
      providerName = null;
    }
  }

  const toolsText = await readToolsFile();
  const identityText = await readIdentityFile();
  let openapiText = "";
  try {
    const openapiModule = require("../express/openapi");
    const doc = openapiModule.createOpenApiDocument(config || {});
    openapiText = JSON.stringify(doc);
  } catch (e) {
    openapiText = "";
  }

  const clientPlatform = getClientPlatform(ctx);
  const systemPrompt = buildAssistantSystemPrompt({
    assistantDisplayName,
    assistantExternalId:
      (chatSummary && chatSummary.contact && chatSummary.contact.externalId) ||
      assistantSender,
    assistantPersona:
      chatSummary && chatSummary.contact ? chatSummary.contact.persona : null,
    toolsText,
    openapiText,
    identityText,
    clientPlatform,
  });

  if (directToolCall) {
    let toolResult;
    try {
      toolResult = await tools[directToolCall.tool](
        userId,
        directToolCall.args,
        ctx,
      );
    } catch (err) {
      const assistErr = `Tool error: ${err.message}`;
      const assistantMsg = await chatService.storeIncomingMessage({
        userId,
        sessionId: null,
        sender: assistantSender,
        displayName: assistantDisplayName,
        body: assistErr,
      });
      io.to(`user:${userId}`).emit("new_message", assistantMsg.message);
      io.to(`user:${userId}`).emit("contact_list_update", assistantMsg.chat);
      return;
    }

    const terminalCommand = getTerminalCommandForTool(
      directToolCall.tool,
      directToolCall.args,
      toolResult,
    );

    if (terminalCommand && toolResult?.id) {
      await storeAssistantTerminalMessage({
        userId,
        chatId,
        assistantSender,
        assistantDisplayName,
        command: terminalCommand,
        terminalId: toolResult.id,
        executed: !!toolResult.executed,
        io,
        toolName: directToolCall.tool,
      });
      return;
    }

    const finalText =
      toolResult && toolResult.executed
        ? directToolCall.directSummary
        : `Saya menyiapkan permintaan menjalankan aplikasi lokal. Request id: ${toolResult.id}`;

    const assistantMsg = await chatService.storeIncomingMessage({
      userId,
      sessionId: null,
      sender: assistantSender,
      displayName: assistantDisplayName,
      body: finalText,
    });
    io.to(`user:${userId}`).emit("new_message", assistantMsg.message);
    io.to(`user:${userId}`).emit("contact_list_update", assistantMsg.chat);
    return;
  }

  // --- Start Autonomous Loop ---
  let turn = 0;
  const maxTurns = 10;
  const conversationHistory = [];

  // Initialize history with system prompt
  conversationHistory.push({ role: "system", content: systemPrompt });
  if (clientPlatform) {
    conversationHistory.push({
      role: "system",
      content: `User device platform: ${clientPlatform}. When providing instructions to open local applications or run OS-specific steps, prefer commands and UI flows for ${clientPlatform}.`,
    });
  }

  if (chatSummary) {
    conversationHistory.push({
      role: "system",
      content: `Active chat with ${chatSummary.contact.displayName} (externalId: ${chatSummary.contact.externalId}). Persona: ${chatSummary.contact.persona || "not set"}. Include recent messages as context.`,
    });

    try {
      const hist = await chatService.listMessages(userId, chatId, {
        take: 10, // Reduced from 40 to prevent context window overflow/fetch failures
      });
      const recent = (hist.messages || [])
        .reverse() // listMessages likely returns desc, we need asc for LLM history
        .map((m) => {
          // Truncate long message bodies in history to keep context clean
          const body = String(m.body || "");
          return {
            ...m,
            body: body.length > 2000 ? body.substring(0, 2000) + "..." : body,
          };
        });

      for (const m of recent) {
        const role = m.direction === "outbound" ? "user" : "assistant";
        const content = buildMessageContentForLLM(m);
        conversationHistory.push({ role, content });
      }
    } catch (e) {
      // ignore history errors
    }
  }

  const currentUserContent = buildLlmUserContent({
    body: assistantInput.body,
    mediaFile,
    providerName,
  });

  conversationHistory.push({
    role: "user",
    content:
      currentUserContent ||
      llmUserMessage ||
      assistantInput.body ||
      "User sent an empty message.",
  });

  // Notify frontend that agent is starting work
  if (io && chatId) {
    io.to(`user:${userId}`).emit("typing_event", {
      chatId,
      isTyping: true,
      name: assistantDisplayName,
      userId: "openwa:assistant",
    });
  }

  try {
    while (turn < maxTurns) {
      turn++;
      let llmResp;
      try {
        llmResp = await llmService.generate(userId, {
          providerId,
          messages: conversationHistory,
          model: "gpt-5-mini", // force gpt-5-mini for agent reasoning
        });
      } catch (err) {
        const fail = formatLlmErrorForUser(err);
        await sendAssistantMessage(
          userId,
          assistantSender,
          assistantDisplayName,
          fail,
          io,
          chatId,
        );
        return;
      }

      const text = String(llmResp?.text || "").trim();
      if (!text) {
        await sendAssistantMessage(
          userId,
          assistantSender,
          assistantDisplayName,
          "Model AI tidak mengembalikan isi respons.",
          io,
          chatId,
        );
        return;
      }

      // Add assistant turn to history
      conversationHistory.push({ role: "assistant", content: text });

      const maybe = tryParseJsonObject(text);
      if (!maybe || !maybe.tool) {
        // Final prose reply
        await sendAssistantMessage(
          userId,
          assistantSender,
          assistantDisplayName,
          text,
          io,
          chatId,
        );
        return;
      }

      // Handle extraction of thinking prose before JSON
      const jsonStart =
        typeof maybe.__jsonStart === "number" ? maybe.__jsonStart : -1;
      const thinkingText =
        jsonStart > 0 ? text.substring(0, jsonStart).trim() : "";
      if (thinkingText) {
        await sendAssistantMessage(
          userId,
          assistantSender,
          assistantDisplayName,
          thinkingText,
          io,
          chatId,
        );
      } else if (text.includes("{") && text.includes("}")) {
        // If there's prose AFTER the JSON or if it was formatted oddly but parsed
        const beforeJson = text.split(/{/)[0].trim();
        if (beforeJson && beforeJson.length > 5) {
          await sendAssistantMessage(
            userId,
            assistantSender,
            assistantDisplayName,
            beforeJson,
            io,
            chatId,
          );
        }
      }

      const toolName = String(maybe.tool || "");
      const args = maybe.args || {};

      if (!tools[toolName]) {
        const errMsg = `Requested tool not found: ${toolName}`;
        conversationHistory.push({ role: "user", content: errMsg });
        continue;
      }

      // Process and execute tool
      let toolResult;
      try {
        // Route run_code_agent invocations through the internal orchestrator.
        // This replaces the old Copilot CLI dependency with the LLM-driven agent.
        if (toolName === "run_code_agent") {
          // Build a concise execution message for the orchestrator
          let promptForExec = "";
          if (args && args.prompt) promptForExec = args.prompt;
          else if (args && args.command) promptForExec = args.command;
          else {
            const lastUser = [...conversationHistory]
              .reverse()
              .find((m) => m.role === "user");
            promptForExec =
              (lastUser && lastUser.content) || assistantInput.body || "";
          }

          const orchesRes = await orchestrator.orchestrate({
            userId,
            message: promptForExec,
            context: Object.assign({}, ctx, { cwd: args && args.cwd }),
            maxSteps: 6,
          });

          if (!orchesRes || !orchesRes.success) {
            throw new Error(
              orchesRes && orchesRes.error
                ? orchesRes.error
                : "orchestrator failed",
            );
          }

          // Synthesize a run_code_agent-like tool result for compatibility
          toolResult = {
            ok: true,
            id: null,
            executed: true,
            result: orchesRes,
          };
        } else {
          toolResult = await tools[toolName](userId, args, ctx);
        }
      } catch (err) {
        const assistErr = `Tool error: ${err.message}`;
        conversationHistory.push({ role: "user", content: assistErr });
        // Fallback: if code agent fails, try run_terminal if prompt is present
        if (
          toolName === "run_code_agent" &&
          (/agent execution failed/i.test(err.message) ||
            /LLM generate failed/i.test(err.message) ||
            /fetch failed/i.test(err.message)) &&
          args &&
          args.prompt
        ) {
          conversationHistory.push({
            role: "user",
            content: `Code agent gagal. Analisa prompt berikut dan buat perintah terminal yang paling relevan dan tepat untuk mencapai tujuan tersebut, lalu jalankan dengan run_terminal di cwd yang sama. Jangan gunakan perintah generik, pastikan sesuai kebutuhan prompt. Prompt: "${args.prompt}"`,
          });
        }
        continue;
      }

      // Special case: terminal commands (async approval)
      const terminalCommand = getTerminalCommandForTool(
        toolName,
        args,
        toolResult,
      );
      if (terminalCommand && toolResult?.id) {
        await storeAssistantTerminalMessage({
          userId,
          chatId,
          assistantSender,
          assistantDisplayName,
          command: terminalCommand,
          terminalId: toolResult.id,
          executed: !!toolResult.executed,
          io,
          toolName,
        });
        // If NOT executed immediately (waiting for manual approval), we stop the loop here.
        if (!toolResult.executed) return;

        // If auto-executed, feed back result and continue
        conversationHistory.push({
          role: "user",
          content: `Tool '${toolName}' execution result: ${JSON.stringify(toolResult)}`,
        });
        continue;
      }

      // Normal tool execution feed back
      conversationHistory.push({
        role: "user",
        content: `Tool '${toolName}' execution result: ${JSON.stringify(toolResult)}. Please continue based on this result.`,
      });
    }

    if (turn >= maxTurns) {
      await sendAssistantMessage(
        userId,
        assistantSender,
        assistantDisplayName,
        "Task exceeds maximum turns limit.",
        io,
        chatId,
      );
    }
  } finally {
    // Notify frontend that agent is done or waiting
    if (io && chatId) {
      io.to(`user:${userId}`).emit("typing_event", {
        chatId,
        isTyping: false,
        name: assistantDisplayName,
        userId: "openwa:assistant",
      });
    }
  }
}

async function sendAssistantMessage(
  userId,
  sender,
  displayName,
  body,
  io,
  chatId,
  mediaFileId = null,
) {
  try {
    let assistantMsg;
    const chat = chatId
      ? await chatService.getChatWithContact(userId, chatId)
      : null;
    const isTelegramChat =
      chat &&
      (chat.transportType === "telegram" ||
        String(chat.contact?.externalId || "").startsWith("tg:"));

    if (isTelegramChat) {
      assistantMsg = await chatService.createOutgoingMessage({
        userId,
        chatId,
        body,
        type: mediaFileId ? "image" : "text",
        mediaFileId,
        skipCrmAutoPause: true,
      });
      const deliveryJob = await outboundDeliveryService.enqueueMessage({
        userId,
        messageId: assistantMsg.message.id,
        io,
      });
      assistantMsg.deliveryJob =
        outboundDeliveryService.serializeJob(deliveryJob);
    } else if (chatId) {
      assistantMsg = await chatService.storeIncomingMessageInChat({
        userId,
        chatId,
        sender,
        body,
        type: mediaFileId ? "image" : "text",
        mediaFileId,
      });
    } else {
      assistantMsg = await chatService.storeIncomingMessage({
        userId,
        sessionId: null,
        sender,
        displayName,
        body,
        mediaFileId,
        type: mediaFileId ? "image" : "text",
      });
    }

    io.to(`user:${userId}`).emit("new_message", assistantMsg.message);
    io.to(`user:${userId}`).emit("contact_list_update", assistantMsg.chat);
  } catch (e) {
    console.error("[sendAssistantMessage] Error:", e);
  }
}

module.exports = {
  handleAssistantMessage,
  readToolsFile,
  updateToolsFile,
  registerExternalTool,
  fetchAndRegisterTool,
  invokeRegisteredTool,
  __internal: {
    buildAssistantSystemPrompt,
    buildAssistantAttachmentInstruction,
    buildLlmUserContent,
    buildMessageContentForLLM,
    buildToolResultFallbackText,
    buildUserRequestSummaryText,
    buildVisionUserContent,
    formatLlmErrorForUser,
    getTerminalCommandForTool,
    isImageMediaFile,
    isVisionCapableProvider,
    normalizeAssistantInput,
    resolveMediaFilePath,
    resolveDirectAssistantToolCall,
    getClientPlatform,
  },
};
