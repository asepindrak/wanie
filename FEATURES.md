# OpenWA Features

This document lists all features available in OpenWA, extracted from the API specification.

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
- Reply to specific messages
- Forward messages to other chats
- Delete sent messages
- Message direction tracking (inbound/outbound)
- Message type support (text, image, video, document, audio, etc.)
- Message delivery status (sent, delivered, read)
- Message timestamps
- Sender and receiver information

## CRM AI Automation

- Dedicated CRM dashboard for customer support workflows
- Global CRM automation mode: off, draft only, or auto send
- Per-chat automation mode overrides
- Per-session automation mode overrides for WhatsApp sessions
- AI draft generation from recent conversation context
- AI auto-reply for inbound customer messages
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
- Persona and brand voice configuration
- Fallback message configuration
- Knowledge similarity threshold, maximum chunks, and embedding model settings

## CRM Knowledge Base

- Upload knowledge documents from the CRM page
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
- Telegram CRM chats support AI draft and auto-reply modes
- Outbound CRM messages can be delivered back to Telegram
- Admin Telegram chat IDs remain reserved for remote OpenWA assistant control
- Non-admin Telegram chat IDs are treated as customer CRM conversations

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
- Remote OpenWA control via Telegram bot with admin allowlist and `/new` chat reset support
- CRM workspace with AI auto-reply, knowledge base, Telegram customer channel support, and automation logs
- Dark theme UI
- Search functionality across messages, chats, and contacts
- Message grouping (consecutive images)
- Reply preview with original message
- Media preview modal
- Emoji picker for message composition
- Settings management
- Logout functionality
