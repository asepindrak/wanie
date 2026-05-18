const path = require("path");
const { prisma } = require("../database/client");
const aiProviderService = require("./ai-provider-service");
const userSettings = require("./user-settings");
const { mediaDir } = require("../utils/paths");

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

function isAudioMediaFile(mediaFile) {
  const mimeType = String(mediaFile?.mimeType || "").toLowerCase();
  const name = String(mediaFile?.originalName || mediaFile?.fileName || "")
    .toLowerCase()
    .trim();

  return (
    mimeType.startsWith("audio/") ||
    name.endsWith(".ogg") ||
    name.endsWith(".opus") ||
    name.endsWith(".mp3") ||
    name.endsWith(".m4a") ||
    name.endsWith(".wav") ||
    name.endsWith(".webm")
  );
}

async function resolveProvider(userId, providerId) {
  const resolvedProviderId =
    providerId || (await userSettings.getSetting(userId, "defaultAiProviderId"));
  if (!resolvedProviderId) {
    throw new Error("Transcription provider is not configured.");
  }

  const provider = await aiProviderService.getProvider(userId, resolvedProviderId);
  if (!provider) {
    throw new Error("Transcription provider not found.");
  }

  return provider;
}

async function transcribeMediaFile(userId, mediaFile, options = {}) {
  if (!isAudioMediaFile(mediaFile)) return "";

  const provider = await resolveProvider(userId, options.providerId);
  const model =
    String(options.model || "").trim() ||
    provider.config?.transcriptionModel ||
    "gpt-4o-mini-transcribe";
  const providerKey = `${provider.provider}:${provider.id}`;

  if (
    mediaFile.transcriptionText &&
    mediaFile.transcriptionProvider === providerKey &&
    mediaFile.transcriptionModel === model
  ) {
    return mediaFile.transcriptionText;
  }

  const adapter = require(`../ai/llm-adapters/${provider.provider}`);
  if (typeof adapter.transcribe !== "function") {
    throw new Error(
      `Provider ${provider.provider} does not support audio transcription.`,
    );
  }

  const filePath = resolveMediaFilePath(mediaFile);
  const result = await adapter.transcribe(provider.config || {}, {
    filePath,
    fileName: mediaFile.originalName || mediaFile.fileName || "audio.ogg",
    mimeType: mediaFile.mimeType || "audio/ogg",
    model,
    language: options.language || "id",
  });
  const text = String(result?.text || "").trim();

  await prisma.mediaFile.update({
    where: { id: mediaFile.id },
    data: {
      transcriptionText: text || null,
      transcriptionProvider: providerKey,
      transcriptionModel: model,
      transcribedAt: new Date(),
    },
  });

  return text;
}

module.exports = {
  isAudioMediaFile,
  transcribeMediaFile,
};
