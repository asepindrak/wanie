function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractOpenAiText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("")
      .trim();
  }
  return data?.choices?.[0]?.text ?? "";
}

function hasChoices(data) {
  return Array.isArray(data?.choices) && data.choices.length > 0;
}

function isRetriableOpenAiFailure(status, bodyText, data) {
  if (status >= 500) return true;
  if (data && !hasChoices(data)) return true;
  return /response contained no choices/i.test(String(bodyText || ""));
}

async function postOpenAiJson(url, apiKey, body, maxAttempts = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastError = new Error(`OpenAI request failed: ${res.status} ${text}`);

      if (attempt < maxAttempts && isRetriableOpenAiFailure(res.status, text)) {
        await delay(250 * attempt);
        continue;
      }

      throw lastError;
    }

    const data = await res.json();
    if (!hasChoices(data)) {
      lastError = new Error("OpenAI response contained no choices.");
      if (attempt < maxAttempts) {
        await delay(250 * attempt);
        continue;
      }
      throw lastError;
    }

    return data;
  }

  throw lastError || new Error("OpenAI request failed.");
}

async function postOpenAiMultipart(url, apiKey, form, maxAttempts = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastError = new Error(`OpenAI request failed: ${res.status} ${text}`);
      if (attempt < maxAttempts && res.status >= 500) {
        await delay(250 * attempt);
        continue;
      }
      throw lastError;
    }

    return res.json();
  }

  throw lastError || new Error("OpenAI request failed.");
}

// Minimal OpenAI adapter stub
// Exports: listModels(config) and generate(config, params)
module.exports = {
  listModels: async function (config = {}) {
    try {
      const pkg = require("openai");
      const OpenAI = pkg?.default || pkg?.OpenAI || pkg;
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (apiKey && OpenAI) {
        const client = new OpenAI({ apiKey });
        if (client.models && typeof client.models.list === "function") {
          const resp = await client.models.list();
          const items = resp?.data || [];
          return items.map((m) => ({
            id: m.id,
            name: m.id,
            description: m.description || "",
          }));
        }
      }
    } catch (e) {
      // ignore - fall back to defaults below
    }

    return [
      { id: "gpt-4", name: "gpt-4" },
      { id: "gpt-3.5-turbo", name: "gpt-3.5-turbo" },
    ];
  },

  generate: async function (config = {}, params = {}) {
    const apiKey = (config && config.apiKey) || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI API key missing. Provide config.apiKey or set OPENAI_API_KEY.",
      );
    }

    if (typeof fetch !== "function") {
      throw new Error(
        "fetch is not available in this Node runtime. Run on Node 18+ or provide a fetch polyfill.",
      );
    }

    const host =
      (config && (config.host || process.env.OPENAI_HOST)) ||
      "https://api.openai.com";
    const base = String(host).replace(/\/$/, "");
    const model = params.model || (config && config.model) || "gpt-3.5-turbo";

    // Chat-style request
    if (Array.isArray(params.messages) && params.messages.length) {
      const url = `${base}/v1/chat/completions`;
      const body = {
        model,
        messages: params.messages,
        max_tokens: params.max_tokens,
      };
      if (params.temperature !== undefined && params.temperature !== null) {
        body.temperature = params.temperature;
      }

      const data = await postOpenAiJson(url, apiKey, body);
      const text = extractOpenAiText(data);
      return { text, raw: data };
    }

    // Prompt/completions-style request
    if (params.prompt || params.prompt === "" || params.prompt === 0) {
      const url = `${base}/v1/completions`;
      const body = {
        model,
        prompt: params.prompt,
        max_tokens: params.max_tokens,
      };
      if (params.temperature !== undefined && params.temperature !== null) {
        body.temperature = params.temperature;
      }

      const data = await postOpenAiJson(url, apiKey, body);
      const text = extractOpenAiText(data);
      return { text, raw: data };
    }

    throw new Error("No messages or prompt provided to OpenAI adapter.");
  },
  transcribe: async function (config = {}, params = {}) {
    const fs = require("fs");
    const path = require("path");
    const apiKey = (config && config.apiKey) || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI API key missing. Provide config.apiKey or set OPENAI_API_KEY.",
      );
    }

    if (typeof fetch !== "function" || typeof FormData !== "function") {
      throw new Error("fetch/FormData is not available in this Node runtime.");
    }

    const filePath = params.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("Audio file not found.");
    }

    const host =
      (config && (config.host || process.env.OPENAI_HOST)) ||
      "https://api.openai.com";
    const base = String(host).replace(/\/$/, "");
    const model =
      params.model ||
      (config && config.transcriptionModel) ||
      "gpt-4o-mini-transcribe";
    const buffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append("model", model);
    form.append(
      "file",
      new Blob([buffer], {
        type: params.mimeType || "audio/ogg",
      }),
      params.fileName || path.basename(filePath),
    );
    if (params.language) {
      form.append("language", params.language);
    }

    const data = await postOpenAiMultipart(
      `${base}/v1/audio/transcriptions`,
      apiKey,
      form,
    );
    return { text: String(data?.text || "").trim(), raw: data, model };
  },
  __internal: {
    delay,
    extractOpenAiText,
    hasChoices,
    isRetriableOpenAiFailure,
    postOpenAiJson,
    postOpenAiMultipart,
  },
};
