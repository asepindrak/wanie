# TOOLS.md

This file documents tools and skills available to the Wanie Assistant.

Default skills:
- add_device: create a new WhatsApp session/device for the user. Use this only for WhatsApp device/session requests, QR pairing, or WhatsApp number connection. Never use this for Telegram.
- add_llm_provider: add an LLM provider (OpenAI/Anthropic/Ollama/OpenRouter).
- update_assistant: change assistant display name, avatar, or persona.
- create_api_key: generate an API key for the user.
- update_webhook: set incoming webhook URL and key.
- setup_gateway_integration: configure Wanie as an API gateway for an external CRM/ERP/app by setting webhook URL/key, optionally creating an API key, and turning internal CRM automation off.
- setup_telegram_bot: set up a Telegram bot to remote Wanie. Use this for any request that mentions Telegram, Telegram bot, BotFather, bot token, or admin Telegram IDs. User must provide a bot token from @BotFather. Do not create a WhatsApp device/session for Telegram setup.
- configure_telegram_admins: set the Telegram admin chat ID allowlist. Use this only for Telegram admin access control.
- get_telegram_bot_status: check whether the user's Telegram bot is configured and currently running.
- get_crm_auto_reply_settings: read CRM auto-reply settings, including assistantName, businessName, persona, agentInstructions, fallbackMessage, automation mode, and retrieval settings.
- update_crm_auto_reply_settings: update CRM auto-reply settings from chat. Use this for CRM auto-reply persona, CRM instruction/SOP, assistantName, businessName, fallbackMessage, and automation settings.
- list_knowledge_base: list CRM knowledge-base documents and their indexing status.
- get_knowledge_base_document: read one existing CRM knowledge-base document before editing it.
- search_knowledge_base: search CRM knowledge-base chunks and return the source chunks that would ground a reply.
- test_knowledge_base_reply: test the CRM knowledge-aware reply for a question and return the draft answer plus source chunks.
- add_knowledge_base: add a new text/Markdown knowledge-base document from chat. The document is automatically chunked and indexed.
- update_knowledge_base: replace or append text in an existing knowledge-base document from chat. The document is automatically chunked and indexed again.
- update_tools_md: update this file with new tools/skills provided by user.

The assistant may append new tool descriptions here when the user provides external tool documentation.

Routing rules:
- If the user asks to set up, connect, configure, check, delete, or manage Telegram, use Telegram tools only.
- If the user asks to add/connect/pair a WhatsApp device or scan a WhatsApp QR code, use add_device.
- If the user asks to edit persona or instructions for CRM auto reply, auto-reply, knowledge-aware reply, customer support AI, or Wanie CRM Assistant, use update_crm_auto_reply_settings instead of update_assistant.
- Use update_assistant only for the Wanie Assistant chat profile itself, not CRM customer auto-reply behavior.
- For CRM auto-reply edits, keep changes literal and narrow. Do not invent policies, prices, guarantees, workflows, tone rules, or business facts. Prefer find/replace when changing one phrase in persona or agentInstructions.
- If the user asks what CRM knowledge exists, use list_knowledge_base.
- If the user asks to show, view, open, display, or lihat data inside a CRM knowledge-base document, use get_knowledge_base_document and include the document content in the reply.
- If the user asks to check, test, simulate, preview, or kira-kira what the CRM AI reply would be from the knowledge base, use test_knowledge_base_reply.
- If a tested knowledge-aware reply is wrong, inspect the returned sources, read the source document with get_knowledge_base_document, then update only the wrong sentence/section with update_knowledge_base according to the user's correction. Prefer find/replace. Do not rewrite the full document unless the user explicitly asks.
- If the user asks to add knowledge-base content from chat, use add_knowledge_base.
- If the user asks to edit an existing knowledge-base document, use list_knowledge_base and get_knowledge_base_document first unless the user gave the exact document id and complete replacement content. Then use update_knowledge_base with a minimal targeted edit. Preserve existing wording, order, and unrelated facts.
- When the requested channel is ambiguous, ask one short clarification question instead of guessing.
