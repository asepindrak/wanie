const path = require("path");
const { rootDir } = require("../utils/paths");

const packageJson = require(path.join(rootDir, "package.json"));

function createOpenApiDocument(config) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Wanie API",
      version: packageJson.version,
      description:
        "HTTP API for the local Wanie runtime, including auth, sessions, chats, contacts, messaging, and runtime metadata. For AI agents, fetch `/docs/readme` first, then authenticate with `X-API-Key` and use the HTTP endpoints directly.",
    },
    servers: [
      {
        url: config.frontendUrl,
        description:
          "Frontend-facing URL with proxied docs/health/version endpoints",
      },
      { url: config.backendUrl, description: "Direct backend API URL" },
    ],
    tags: [
      { name: "Runtime" },
      { name: "Webhooks" },
      { name: "WhatsApp Official API" },
      { name: "Auth" },
      { name: "Workspace" },
      { name: "Sessions" },
      { name: "Chats" },
      { name: "Contacts" },
      { name: "Messages" },
      { name: "Media" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
          required: ["error"],
        },
        WebhookConfig: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            url: { type: "string", format: "uri" },
            apiKey: { type: "string" },
            method: {
              type: "string",
              enum: ["POST", "PUT", "PATCH"],
            },
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
              description:
                "Optional custom headers for the outbound webhook request.",
            },
            bodyTemplate: {
              type: "string",
              description:
                "Optional JSON body template. Leave empty to send the default Wanie payload.",
            },
          },
        },
        WebhookPayload: {
          type: "object",
          description:
            "Payload delivered to configured webhooks for incoming messages",
          properties: {
            chat: { $ref: "#/components/schemas/Chat" },
            message: { $ref: "#/components/schemas/Message" },
          },
        },
        WebhookResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            webhook: { $ref: "#/components/schemas/WebhookConfig" },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            createdAt: { type: "string", format: "date-time" },
          },
          required: ["id", "name", "email", "createdAt"],
        },
        AuthResponse: {
          type: "object",
          properties: {
            token: { type: "string" },
            user: { $ref: "#/components/schemas/User" },
          },
          required: ["token", "user"],
        },
        Session: {
          type: "object",
          properties: {
            id: { type: "string" },
            userId: { type: "string" },
            name: { type: "string" },
            phoneNumber: { type: ["string", "null"] },
            status: { type: "string" },
            transportType: {
              type: ["string", "null"],
              enum: ["wwebjs", "mock", "whatsapp_cloud", null],
            },
            qrCode: { type: ["string", "null"] },
            errorMessage: { type: ["string", "null"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Contact: {
          type: "object",
          properties: {
            id: { type: "string" },
            externalId: { type: "string" },
            displayName: { type: "string" },
            avatarUrl: { type: ["string", "null"] },
            lastMessagePreview: { type: ["string", "null"] },
            lastMessageAt: { type: ["string", "null"], format: "date-time" },
            unreadCount: { type: "integer" },
            sessionId: { type: ["string", "null"] },
            hasChat: { type: "boolean" },
          },
        },
        MediaFile: {
          type: "object",
          properties: {
            id: { type: "string" },
            originalName: { type: "string" },
            mimeType: { type: "string" },
            relativePath: { type: "string" },
          },
        },
        MessageStatus: {
          type: "object",
          properties: {
            status: { type: "string" },
          },
        },
        Message: {
          type: "object",
          properties: {
            id: { type: "string" },
            chatId: { type: "string" },
            sessionId: { type: ["string", "null"] },
            sender: { type: "string" },
            receiver: { type: "string" },
            body: { type: ["string", "null"] },
            type: { type: "string" },
            direction: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            mediaFile: {
              anyOf: [
                { $ref: "#/components/schemas/MediaFile" },
                { type: "null" },
              ],
            },
            statuses: {
              type: "array",
              items: { $ref: "#/components/schemas/MessageStatus" },
            },
          },
        },
        Chat: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: ["string", "null"] },
            sessionId: { type: ["string", "null"] },
            contact: { $ref: "#/components/schemas/Contact" },
            lastMessage: {
              anyOf: [
                { $ref: "#/components/schemas/Message" },
                { type: "null" },
              ],
            },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["Runtime"],
          summary: "Health check",
          responses: {
            200: {
              description: "Runtime health status",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      service: { type: "string" },
                      version: { type: "string" },
                    },
                    required: ["ok", "service", "version"],
                  },
                },
              },
            },
          },
        },
      },
      "/version": {
        get: {
          tags: ["Runtime"],
          summary: "Get API version",
          responses: {
            200: {
              description: "Package version",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      version: { type: "string" },
                    },
                    required: ["name", "version"],
                  },
                },
              },
            },
          },
        },
      },
      "/api/whatsapp/meta/webhook": {
        get: {
          tags: ["WhatsApp Official API"],
          summary: "Verify Meta WhatsApp webhook",
          description:
            "Webhook verification endpoint for Meta Cloud API. Configure this URL in Meta Developer settings as the WhatsApp webhook callback.",
          parameters: [
            {
              name: "hub.mode",
              in: "query",
              schema: { type: "string" },
            },
            {
              name: "hub.verify_token",
              in: "query",
              schema: { type: "string" },
            },
            {
              name: "hub.challenge",
              in: "query",
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Verification challenge returned as plain text",
              content: { "text/plain": { schema: { type: "string" } } },
            },
            403: { description: "Verify token did not match a configured device" },
          },
        },
        post: {
          tags: ["WhatsApp Official API"],
          summary: "Receive Meta WhatsApp webhook events",
          description:
            "Receives WhatsApp Cloud API message and status events from Meta. Incoming messages are stored as Wanie chats/messages and can trigger CRM automation and outbound webhooks.",
          parameters: [
            {
              name: "x-hub-signature-256",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                "Meta request signature. Verified when the device has an app secret configured.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            200: {
              description: "Webhook accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                    required: ["ok"],
                  },
                },
              },
            },
          },
        },
      },
      "/api/webhook": {
        get: {
          tags: ["Webhooks"],
          summary: "Get current webhook configuration",
          description:
            "Return the configured outgoing webhook for the authenticated user. Agents should use API keys to authenticate.",
          operationId: "getWebhook",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            200: {
              description: "Webhook configuration",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/WebhookResponse",
                  },
                },
              },
            },
          },
          "x-ai-agent-ready": true,
        },
        post: {
          tags: ["Webhooks"],
          summary: "Set or update webhook configuration",
          description:
            "Configure an endpoint to receive incoming messages. By default the runtime sends JSON with `x-wanie-webhook-key` and legacy `x-openwa-webhook-key`; advanced settings can customize method, headers, and body template.",
          operationId: "setWebhook",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookConfig" },
                examples: {
                  defaultWebhook: {
                    summary: "Default webhook",
                    value: {
                      enabled: true,
                      url: "https://example.com/wanie-webhook",
                      apiKey: "S3CR3T",
                    },
                  },
                  customHeaders: {
                    summary: "Webhook with custom headers",
                    value: {
                      enabled: true,
                      url: "https://example.com/wanie-webhook",
                      method: "POST",
                      headers: {
                        Authorization: "Bearer external-app-token",
                        "x-api-key": "external-api-key",
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Saved webhook",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/WebhookResponse",
                  },
                },
              },
            },
          },
          "x-ai-agent-ready": true,
        },
        delete: {
          tags: ["Webhooks"],
          summary: "Remove webhook configuration",
          operationId: "deleteWebhook",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            200: { description: "Deleted" },
          },
          "x-ai-agent-ready": true,
        },
      },
      "/docs/json": {
        get: {
          tags: ["Runtime"],
          summary: "Get OpenAPI document",
          responses: {
            200: {
              description: "OpenAPI JSON document",
            },
          },
        },
      },
      "/docs/readme": {
        get: {
          tags: ["Runtime"],
          summary: "Get agent-friendly API usage guide",
          responses: {
            200: {
              description: "Markdown guide for AI agents and external clients",
            },
          },
        },
      },
      "/api/webhook/test": {
        post: {
          tags: ["Webhooks"],
          summary: "Send a test webhook payload",
          description:
            "Deliver a synthetic webhook.test payload to the configured webhook URL and store the attempt in webhook delivery logs.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            200: { description: "Webhook test delivery result" },
            400: { description: "Webhook is not configured or delivery failed" },
          },
        },
      },
      "/api/health": {
        get: {
          tags: ["Runtime"],
          summary: "Backend health alias",
          responses: {
            200: {
              description: "Backend health status",
            },
          },
        },
      },
      "/api/auth/register": {
        post: {
          tags: ["Auth"],
          summary: "Register a user",
          description:
            "Dashboard-oriented auth. External agents should normally use an API key instead of calling register.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                  required: ["name", "email", "password"],
                },
              },
            },
          },
          responses: {
            201: {
              description: "User registered",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthResponse" },
                },
              },
            },
            400: {
              description: "Validation error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "Login a user",
          description:
            "Dashboard-oriented auth. External agents normally do not need this when an API key is already provided.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                  required: ["email", "password"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "User logged in",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthResponse" },
                },
              },
            },
            400: {
              description: "Invalid credentials",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/auth/me": {
        get: {
          tags: ["Auth"],
          summary: "Get authenticated user",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            200: {
              description: "Current user",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      user: { $ref: "#/components/schemas/User" },
                    },
                    required: ["user"],
                  },
                },
              },
            },
            401: {
              description: "Unauthorized",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/api/api-keys": {
        get: {
          tags: ["Auth"],
          summary: "List API keys for the current user",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "API key list",
            },
          },
        },
        post: {
          tags: ["Auth"],
          summary: "Create an API key",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                  },
                  required: ["name"],
                },
              },
            },
          },
          responses: {
            201: {
              description: "Created API key",
            },
          },
        },
      },
      "/api/api-keys/{apiKeyId}": {
        delete: {
          tags: ["Auth"],
          summary: "Revoke an API key",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "apiKeyId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Revoked API key",
            },
          },
        },
      },
      "/api/bootstrap": {
        get: {
          tags: ["Workspace"],
          summary: "Load initial workspace payload",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            200: {
              description: "Workspace bootstrap",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      user: { $ref: "#/components/schemas/User" },
                      sessions: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Session" },
                      },
                      chats: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Chat" },
                      },
                      activeChatId: { type: ["string", "null"] },
                      messages: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Message" },
                      },
                      hasMoreMessages: { type: "boolean" },
                      nextBefore: { type: ["string", "null"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/sessions": {
        get: {
          tags: ["Sessions"],
          summary: "List WhatsApp sessions",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            200: {
              description: "Session list",
            },
          },
        },
        post: {
          tags: ["Sessions"],
          summary: "Create a WhatsApp session",
          description:
            "Create a WhatsApp Web QR session by default, or create a WhatsApp Official API / Meta Cloud API session by setting `transportType` to `whatsapp_cloud` and providing Meta credentials.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    phoneNumber: { type: "string" },
                    transportType: {
                      type: "string",
                      enum: ["wwebjs", "whatsapp_cloud", "mock"],
                      default: "wwebjs",
                    },
                    metaPhoneNumberId: {
                      type: "string",
                      description:
                        "Required when `transportType` is `whatsapp_cloud`.",
                    },
                    metaBusinessAccountId: {
                      type: "string",
                      description:
                        "Optional WhatsApp Business Account ID for reference.",
                    },
                    metaAccessToken: {
                      type: "string",
                      description:
                        "Required when `transportType` is `whatsapp_cloud`. Stored encrypted.",
                    },
                    metaVerifyToken: {
                      type: "string",
                      description:
                        "Required when `transportType` is `whatsapp_cloud`. Must match Meta webhook verification.",
                    },
                    metaAppSecret: {
                      type: "string",
                      description:
                        "Optional Meta app secret used to verify signed webhook payloads. Stored encrypted.",
                    },
                  },
                  required: ["name"],
                },
                examples: {
                  whatsappWebQr: {
                    summary: "WhatsApp Web QR session",
                    value: {
                      name: "Customer Support WhatsApp",
                      transportType: "wwebjs",
                    },
                  },
                  whatsappOfficialApi: {
                    summary: "WhatsApp Official API session",
                    value: {
                      name: "Official Support Line",
                      transportType: "whatsapp_cloud",
                      phoneNumber: "+6281234567890",
                      metaPhoneNumberId: "123456789012345",
                      metaBusinessAccountId: "987654321098765",
                      metaAccessToken: "EAAB...",
                      metaVerifyToken: "openwa-meta-verify-token",
                      metaAppSecret: "meta-app-secret",
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: "Created session",
            },
          },
        },
      },
      "/api/sessions/{sessionId}/connect": {
        post: {
          tags: ["Sessions"],
          summary: "Connect a WhatsApp session",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Updated session",
            },
          },
        },
      },
      "/api/sessions/{sessionId}/disconnect": {
        post: {
          tags: ["Sessions"],
          summary: "Disconnect a WhatsApp session",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Updated session",
            },
          },
        },
      },
      "/api/chats": {
        get: {
          tags: ["Chats"],
          summary: "List chats",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
            {
              name: "q",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Chat list",
            },
          },
        },
      },
      "/api/contacts": {
        get: {
          tags: ["Contacts"],
          summary: "List contacts",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
            {
              name: "q",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Contact list",
            },
          },
        },
      },
      "/api/contacts/{contactId}/open": {
        post: {
          tags: ["Contacts"],
          summary: "Open or create a chat for a contact",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "contactId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Opened chat",
            },
          },
        },
      },
      "/api/chats/{chatId}/messages": {
        get: {
          tags: ["Messages"],
          summary: "List messages for a chat",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "take",
              in: "query",
              required: false,
              schema: { type: "integer" },
            },
            {
              name: "before",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "search",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Messages payload",
            },
          },
        },
      },
      "/api/chats/{chatId}/messages/send": {
        post: {
          tags: ["Messages"],
          summary: "Send a message over HTTP",
          description:
            "Preferred for AI agents and external clients that do not use Socket.IO. Wanie resolves the chat transport automatically, including WhatsApp Web, WhatsApp Official API, and Telegram chats. Supports text messages directly and media messages via an uploaded `mediaFileId`.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    body: { type: "string" },
                    type: {
                      type: "string",
                      enum: [
                        "text",
                        "image",
                        "video",
                        "audio",
                        "document",
                        "sticker",
                      ],
                    },
                    mediaFileId: { type: "string" },
                    replyToId: { type: "string" },
                  },
                },
                examples: {
                  textMessage: {
                    summary: "Send a text message",
                    value: {
                      body: "Halo dari agent",
                      type: "text",
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Sent message payload",
            },
          },
        },
      },
      "/api/messages/send": {
        post: {
          tags: ["Messages"],
          summary: "Send a message directly to a WhatsApp number or chat",
          description:
            "Send a WhatsApp message using either an existing chatId or a direct phoneNumber. The session transport can be WhatsApp Web or WhatsApp Official API. If the chat does not exist yet, the runtime will open a chat for the given WhatsApp number.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["sessionId"],
                  properties: {
                    chatId: { type: "string" },
                    phoneNumber: { type: "string" },
                    sessionId: {
                      type: "string",
                      description:
                        "Required WhatsApp sessionId used to choose which connected device sends the message.",
                    },
                    displayName: { type: "string" },
                    body: { type: "string" },
                    type: {
                      type: "string",
                      enum: [
                        "text",
                        "image",
                        "video",
                        "audio",
                        "document",
                        "sticker",
                      ],
                    },
                    mediaFileId: { type: "string" },
                    mediaUrl: { type: "string", format: "uri" },
                    replyToId: { type: "string" },
                  },
                },
                examples: {
                  directTextMessage: {
                    summary: "Send a text message by phone number",
                    value: {
                      phoneNumber: "+6281234567890",
                      sessionId: "session-id-abc123",
                      body: "Halo, ini follow up customer",
                      type: "text",
                    },
                  },
                  directMediaMessage: {
                    summary: "Send a media message by URL",
                    value: {
                      phoneNumber: "+6281234567890",
                      sessionId: "session-id-abc123",
                      mediaUrl: "https://example.com/image.jpg",
                      type: "image",
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Sent message payload",
            },
          },
        },
      },
      "/api/outbound-deliveries": {
        get: {
          tags: ["Messages"],
          summary: "List outbound delivery jobs",
          description:
            "List recent WhatsApp Web, WhatsApp Official API, and Telegram delivery jobs. Failed jobs stopped after capped retry and can be retried manually.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "status",
              in: "query",
              schema: {
                type: "string",
                enum: ["queued", "sending", "delivered", "failed", "canceled"],
              },
            },
            {
              name: "chatId",
              in: "query",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100 },
            },
          ],
          responses: {
            200: { description: "Outbound delivery jobs" },
          },
        },
      },
      "/api/outbound-deliveries/{deliveryId}/retry": {
        post: {
          tags: ["Messages"],
          summary: "Retry an outbound delivery job",
          description:
            "Reset attempts and retry a failed or queued outbound WhatsApp Web, WhatsApp Official API, or Telegram delivery.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "deliveryId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Retried outbound delivery job" },
          },
        },
      },
      "/api/outbound-deliveries/{deliveryId}/cancel": {
        post: {
          tags: ["Messages"],
          summary: "Cancel an outbound delivery job",
          description:
            "Stop retrying a queued or sending outbound WhatsApp Web, WhatsApp Official API, or Telegram delivery job.",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "deliveryId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Canceled outbound delivery job" },
          },
        },
      },
      "/api/messages/{messageId}": {
        delete: {
          tags: ["Messages"],
          summary: "Delete a message",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "messageId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: {
              description: "Delete result",
            },
          },
        },
      },
      "/api/messages/{messageId}/forward": {
        post: {
          tags: ["Messages"],
          summary: "Forward a message",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: "messageId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    targetChatId: { type: "string" },
                  },
                  required: ["targetChatId"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Forward result",
            },
          },
        },
      },
      "/api/media": {
        post: {
          tags: ["Media"],
          summary: "Upload media",
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                    },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            201: {
              description: "Uploaded media metadata",
            },
          },
        },
      },
    },
  };
}

function createSwaggerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wanie API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #f4f5f7;
        color: #1f2937;
      }

      #swagger-ui {
        min-height: 100vh;
      }

      .swagger-ui .topbar {
        display: none;
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/docs/json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        displayRequestDuration: true,
        presets: [SwaggerUIBundle.presets.apis]
      });
    </script>
  </body>
</html>`;
}

function createAgentReadme(config, apiKeySecret) {
  const keyBlock = apiKeySecret
    ? `

## API Key (auto-generated)

Use this API key for agent requests:

\`X-API-Key: ${apiKeySecret}\`

or

\`Authorization: Bearer ${apiKeySecret}\`
`
    : "";

  return `# Wanie Agent Guide

Recommended base URL for agents:

- ${config.frontendUrl}

Use the frontend URL because docs and runtime metadata endpoints are already proxied to the backend.

## Authentication

Use either of these headers:

\`\`\`
X-API-Key: <api-key>
\`\`\`

or

\`\`\`
Authorization: Bearer <api-key>
\`\`\`

Agents do **not** need to log in through dashboard auth endpoints as long as they already have an API key.

${keyBlock}

## Quick start

1. Check runtime availability:
  - \`GET /health\`
  - \`GET /version\`
2. Fetch the machine-readable specification:
  - \`GET /docs/json\`
3. List and manage WhatsApp sessions:
  - \`GET /api/sessions\`
  - \`POST /api/sessions\` — create either a WhatsApp Web QR session or a WhatsApp Official API / Meta Cloud API session
  - \`POST /api/sessions/:sessionId/connect\`
  - \`POST /api/sessions/:sessionId/disconnect\`
4. Read chats and contacts:
  - \`GET /api/chats\`
  - \`GET /api/contacts\`
5. Open or create a chat from a contact:
  - \`POST /api/contacts/:contactId/open\`
6. Read or search messages:
  - \`GET /api/chats/:chatId/messages\`
  - \`GET /api/chats/:chatId/messages?search=keyword\`
7. Send a message:
  - \`POST /api/chats/:chatId/messages/send\`
  - \`POST /api/messages/send\` — send directly by \`phoneNumber\`, including \`mediaUrl\` or \`mediaFileId\` for media messages
8. Track outbound delivery:
  - \`GET /api/outbound-deliveries\` — list recent outbound WhatsApp or Telegram delivery jobs
  - \`POST /api/outbound-deliveries/:deliveryId/retry\` — reset and retry a failed outbound delivery
  - \`POST /api/outbound-deliveries/:deliveryId/cancel\` — stop retrying a queued outbound delivery

> \`sessionId\` is required when sending a new WhatsApp message by \`phoneNumber\`. Replies to an existing chat can use \`/api/chats/:chatId/messages/send\`; Wanie uses the chat transport, including WhatsApp Web chats, WhatsApp Official API chats, and Telegram chats whose receiver starts with \`tg:\`.

Outbound sends are queued durably and retried with backoff when WhatsApp Web, WhatsApp Official API, or Telegram delivery fails. Wanie stops after 5 attempts by default and marks the delivery job as \`failed\`; use the retry endpoint to try again manually.

## WhatsApp Official API / Meta Cloud API

Wanie can receive and send WhatsApp messages through either WhatsApp Web QR sessions or WhatsApp Official API / Meta Cloud API sessions.

To add an official API device from the dashboard:

1. Open **Settings -> Devices**.
2. Choose **WhatsApp Official API**.
3. Enter the Meta Phone Number ID, access token, and webhook verify token.
4. Optionally enter the WhatsApp Business Account ID and App Secret.
5. Configure the Meta webhook callback URL as:

\`\`\`
${config.frontendUrl}/api/whatsapp/meta/webhook
\`\`\`

Official API chats use the same Wanie chat IDs, message APIs, CRM automation, incoming webhooks, media upload flow, and outbound delivery queue as WhatsApp Web chats. Incoming text, media, location, button, and interactive messages are stored as normal Wanie messages.

Free-form outbound replies are intended for Meta's customer service window. Template-message sending for conversations outside that window is not implemented yet.

### Example payloads

Send a text message to an existing chat:
\`\`\`json
{
  "body": "Halo, ini follow up customer",
  "type": "text"
}
\`\`\`

Send a direct message by phone number:
\`\`\`json
{
  "sessionId": "<sessionId>",
  "phoneNumber": "+6281234567890",
  "body": "Halo, ini follow up customer",
  "type": "text"
}
\`\`\`

Media message by URL:
\`\`\`json
{
  "mediaUrl": "https://example.com/image.jpg",
  "body": "Caption opsional",
  "type": "image"
}
\`\`\`

## Webhooks

Use webhooks when an external CRM, ERP, helpdesk, or AI service should receive incoming customer messages and reply through the Wanie API.

Configure webhooks:

- \`GET /api/webhook\` — read current webhook configuration.
- \`POST /api/webhook\` — set webhook \`{ "url": "https://example.com/wanie-webhook", "apiKey": "shared-secret" }\`.
- \`DELETE /api/webhook\` — remove the webhook.
- \`POST /api/webhook/test\` — send a synthetic \`webhook.test\` payload to the configured URL.
- \`GET /api/webhook/deliveries\` — list recent webhook delivery attempts.
- \`POST /api/webhook/deliveries/:deliveryId/retry\` — replay a stored webhook payload.

Wanie sends this request to your endpoint:

\`\`\`http
POST <your-webhook-url>
Content-Type: application/json
x-wanie-webhook-key: <apiKey configured in Wanie>
x-openwa-webhook-key: <same apiKey, sent for backward compatibility>
\`\`\`

When an incoming WhatsApp Web, WhatsApp Official API, or non-admin Telegram customer message arrives the runtime will \`POST\` a JSON payload to your configured URL with header \`x-wanie-webhook-key\` set to the \`apiKey\` you provided. The legacy \`x-openwa-webhook-key\` header is also sent for backward compatibility. The payload contains \`chat\` and \`message\` objects described in the OpenAPI schemas. Store \`chat.id\` and reply through \`POST /api/chats/:chatId/messages/send\`.

Webhook deliveries are logged per user. Wanie retries transient delivery failures automatically, and failed deliveries can be replayed with the retry endpoint.

Example payload:

\`\`\`json
{
  "chat": {
    "id": "chat_id_from_wanie",
    "title": "Customer Name",
    "sessionId": "whatsapp_session_id_or_null_for_telegram",
    "contact": {
      "externalId": "6281234567890@c.us, wa:6281234567890, or tg:123456789"
    }
  },
  "message": {
    "id": "message_id_from_wanie",
    "chatId": "chat_id_from_wanie",
    "sessionId": "whatsapp_session_id_or_null_for_telegram",
    "sender": "6281234567890@c.us, wa:6281234567890, or tg:123456789",
    "receiver": "your_whatsapp_or_telegram_target",
    "body": "Customer message text",
    "type": "text",
    "direction": "inbound",
    "mediaFile": null,
    "statuses": []
  }
}
\`\`\`

Minimal Express receiver:

\`\`\`js
app.post("/wanie-webhook", express.json(), async (req, res) => {
  const key = req.get("x-wanie-webhook-key") || req.get("x-openwa-webhook-key");
  if (key !== process.env.WANIE_WEBHOOK_KEY) {
    return res.status(401).json({ ok: false });
  }

  const { chat, message } = req.body;
  console.log("Incoming Wanie message", {
    chatId: chat.id,
    from: message.sender,
    text: message.body,
  });

  res.json({ ok: true });
});
\`\`\`

Reply to the same WhatsApp Web, WhatsApp Official API, or Telegram chat:

\`\`\`bash
curl -X POST ${config.frontendUrl}/api/chats/<chatId>/messages/send \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: <api-key>" \\
  -d '{"body":"Reply from external CRM","type":"text"}'
\`\`\`

Send media to the same chat with a public URL:

\`\`\`bash
curl -X POST ${config.frontendUrl}/api/chats/<chatId>/messages/send \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: <api-key>" \\
  -d '{"type":"image","mediaUrl":"https://example.com/photo.jpg","body":"Photo caption"}'
\`\`\`

Or upload media first:

\`\`\`bash
curl -X POST ${config.frontendUrl}/api/media \\
  -H "X-API-Key: <api-key>" \\
  -F "file=@./invoice.pdf"
\`\`\`

Then send:

\`\`\`bash
curl -X POST ${config.frontendUrl}/api/chats/<chatId>/messages/send \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: <api-key>" \\
  -d '{"type":"document","mediaFileId":"<mediaFileId>","body":"Invoice"}'
\`\`\`

For API-only gateway mode, set internal CRM automation to **Off**. Wanie will still store incoming messages, deliver webhooks, and allow the external app to reply through API endpoints.

## Important notes

 - \`/api/auth/register\` and \`/api/auth/login\` are meant for dashboard or human login flows, not the normal agent flow.
 - API keys are created from the Wanie dashboard under **Settings → API Access**.
 - For media messages, upload the file to \`POST /api/media\` first, then send the returned \`mediaFileId\` through the HTTP send message endpoint.
 - Main business endpoints accept JWT **or** API key authentication, but API key management endpoints only accept dashboard JWT authentication.
`;
}
module.exports = {
  createOpenApiDocument,
  createAgentReadme,
  createSwaggerHtml,
  packageVersion: packageJson.version,
  packageName: packageJson.name,
};
