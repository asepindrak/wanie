const crypto = require("crypto");
const { prisma } = require("../database/client");

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt
  };
}

function hashApiKey(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function generateApiKeySecret() {
  return `wanie_live_${crypto.randomBytes(24).toString("hex")}`;
}

function sanitizeApiKey(record) {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    last4: record.last4,
    maskedKey: `${record.keyPrefix}...${record.last4}`,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function retryOnSqliteTimeout(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code !== "P1008") {
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    return operation();
  }
}

async function listApiKeys(userId) {
  const apiKeys = await prisma.apiKey.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });

  return apiKeys.map(sanitizeApiKey);
}

async function createApiKey(userId, { name }) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    throw new Error("API key name is required.");
  }

  const secret = generateApiKeySecret();
  const record = await retryOnSqliteTimeout(() =>
    prisma.apiKey.create({
      data: {
        userId,
        name: trimmedName,
        keyHash: hashApiKey(secret),
        keyPrefix: secret.slice(0, 12),
        last4: secret.slice(-4)
      }
    })
  );

  return {
    apiKey: sanitizeApiKey(record),
    secret
  };
}

async function revokeApiKey(userId, apiKeyId) {
  const result = await retryOnSqliteTimeout(() =>
    prisma.apiKey.deleteMany({
      where: {
        id: apiKeyId,
        userId
      }
    })
  );

  if (!result.count) {
    throw new Error("API key not found.");
  }

  return { ok: true };
}

async function getUserFromApiKey(secret) {
  if (!secret) {
    return null;
  }

  const record = await prisma.apiKey.findUnique({
    where: {
      keyHash: hashApiKey(secret)
    },
    include: {
      user: true
    }
  });

  if (!record) {
    return null;
  }

  await retryOnSqliteTimeout(() =>
    prisma.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() }
    })
  );

  return sanitizeUser(record.user);
}

module.exports = {
  createApiKey,
  getUserFromApiKey,
  listApiKeys,
  revokeApiKey
};
