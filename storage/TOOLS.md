# TOOLS.md

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
