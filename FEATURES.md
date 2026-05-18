# Wanie Features

This document lists all features available in Wanie, extracted from the API specification.

## Authentication

- Register new workspace account
- Login to existing account
- JWT bearer token authentication for dashboard users
- API key authentication for agents and external integrations

## Workspace

- Bootstrap endpoint for initial data load
- Load current user information
- Load list of sessions
- Load list of chats
- Load active chat ID
- Load initial messages for active chat

## Sessions (Multi-device Management)

- Create new WhatsApp session
- Connect/pair session with WhatsApp via QR code
- Add WhatsApp Official API / Meta Cloud API sessions without QR pairing
- Store Meta access token and app secret encrypted in runtime storage
- Verify Meta webhook callbacks with a per-device verify token
- Validate signed Meta webhook payloads when an app secret is configured
- Disconnect/logout session
- List all sessions
- Session status tracking (pending, connected, disconnected, error)
- Phone number assignment
- QR code generation for mobile authentication

## Contacts

- Browse all contacts
- Search contacts by name, phone number, or message preview
- Open contact to start new chat
- Contact avatar support
- Unread message count per contact
- Last message preview
- Last message timestamp

## Chats

- Browse all chats (conversations)
- Search chats by contact name, title, or message content
- Open chat to view messages
- Chat ordering (most recent first)
- Contact information in chat
- Latest message preview in chat
- Chat status and timestamps

## Messages

- List messages in a chat
- Search messages within chat
- Send text messages
- Send media messages (images, videos, documents, audio)
- Send text and media through WhatsApp Official API / Meta Cloud API sessions
- Reply to specific messages
- Forward messages to other chats
- Delete sent messages
- Message direction tracking (inbound/outbound)
- Message type support (text, image, video, document, audio, etc.)
- Message delivery status (sent, delivered, read)
- WhatsApp Official API status webhook mapping for sent, delivered, and read receipts
- Durable outbound delivery queue with capped retry, cancel, cleanup, and manual retry for failed sends
- Active WhatsApp device health checks with automatic reconnect and backoff
- Message timestamps
- Sender and receiver information

## CRM AI Automation

- Dedicated CRM dashboard for customer support workflows
- Global CRM automation mode: off, draft only, or auto send
- Telegram CRM off mode stores non-admin messages in the dashboard and sends an inactive automation notice
- Per-chat automation mode overrides
- Per-session automation mode overrides for WhatsApp sessions
- AI draft generation from recent conversation context
- AI auto-reply for inbound customer messages
- Auto-reply pauses temporarily per chat after an admin replies from Wanie or the WhatsApp app
- WhatsApp group auto-reply is off by default and requires an explicit per-chat Auto send override
- Knowledge-base grounded responses using uploaded documents
- Conversation-aware prompts with recent message transcript
- Multi-message debounce before auto-reply so rapid follow-up messages are answered as one context
- Retry handling for AI generation and outbound message delivery
- Fallback message delivery when AI generation fails
- Abuse-rate guard for excessive inbound message bursts
- Abuse cooldown notice sent back to the customer on WhatsApp or Telegram
- Daily maximum auto-reply limit per chat
- CRM automation activity logs for sent replies, generated drafts, skips, and errors
- Source snippets stored with automation logs for traceability
- CRM assistant name and business name configuration for stable bot identity
- Persona and brand voice configuration
- Fallback message configuration
- Knowledge similarity threshold, maximum chunks, and embedding model settings

## CRM Knowledge Base

- Upload one or multiple knowledge documents from the CRM page
- Auto-replace existing knowledge documents when the uploaded original filename matches
- Supported plain-text knowledge files: TXT, Markdown, CSV, and JSON
- Supported office files: PDF, DOCX, and XLSX
- CSV knowledge extraction with row/column labels for easier AI retrieval
- Document status tracking: processing, ready, and failed
- Knowledge chunking and indexing
- Reindex existing knowledge documents after configuration or parser changes
- Keyword retrieval fallback when embeddings are not configured
- Optional embedding-based retrieval when an embedding provider is configured
- Knowledge test chat for validating answers before enabling auto-reply

## Telegram CRM Channel

- Telegram bot can receive customer messages as CRM chats
- Telegram customer messages are stored in the same chat/message database
- Telegram customer messages are delivered to configured incoming webhooks
- Webhook delivery attempts are logged, testable from settings, retried by a durable worker, updated in realtime, cleaned up by retention, and failed payloads can be retried
- Webhook shared secrets are stored encrypted in the runtime config store
- Telegram CRM chats support AI draft and auto-reply modes
- Telegram chats with CRM mode off are stored in the dashboard without giving non-admin users assistant tool access
- Outbound CRM and API messages can be delivered back to Telegram
- Admin Telegram chat IDs remain reserved for remote Wanie assistant control
- Admin Telegram chat ID allowlist can be managed from Settings
- Non-admin Telegram chat IDs are treated as customer conversations and cannot use the remote assistant tools

## WhatsApp Official API Channel

- WhatsApp Official API / Meta Cloud API devices can be added from Settings
- Meta webhook callback endpoint at `/api/whatsapp/meta/webhook`
- Incoming official API messages are stored in the same chat/message database
- Supported inbound message types include text, images, videos, documents, audio, locations, buttons, and interactive replies
- Meta-hosted inbound media is downloaded into Wanie media storage
- Outbound dashboard, CRM, and API replies can be sent through Meta Cloud API
- Official API chats can trigger CRM draft and auto-reply automation
- Official API chats can trigger incoming-message webhooks for external apps
- Official API transport uses the same durable outbound retry queue as WhatsApp Web and Telegram

## Media

- Multipart media file upload
- Media file storage with file paths
- Media association with messages via mediaFileId
- Support for images, videos, documents, audio files

## Runtime Documentation

- Swagger UI for interactive API exploration
- OpenAPI 3.1.0 specification JSON
- Agent-friendly README documentation
- Health check endpoint
- Version information endpoint
- Runtime metadata

## Real-time Updates

- Socket.IO connection for real-time message updates
- Typing indicators
- Online status
- Message delivery status updates
- Session status changes
- Chat updates
- Contact updates

## Additional Features

- Local-first architecture
- Self-hosted deployment
- CLI package format
- Next.js dashboard frontend
- Express API backend
- Prisma ORM with SQLite database
- Multi-user support
- Multi-session support per user
- Remote Wanie control via Telegram bot with admin allowlist and `/new` chat reset support
- CRM workspace with AI auto-reply, knowledge base, Telegram customer channel support, and automation logs
- Dark theme UI
- Search functionality across messages, chats, and contacts
- Message grouping (consecutive images)
- Reply preview with original message
- Media preview modal
- Emoji picker for message composition
- Settings management
- Logout functionality
