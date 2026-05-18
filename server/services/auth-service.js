const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("../database/client");
const { getUserFromApiKey } = require("./api-key-service");

async function retryOnSqliteTimeout(operation) {
  let lastError = null;
  for (const delayMs of [0, 100, 250, 500]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      return await operation();
    } catch (error) {
      if (error?.code !== "P1008") {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
}

function isSqliteTimeoutError(error) {
  return error?.code === "P1008";
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}

function issueToken(user, config) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: "7d",
  });
}

async function registerUser({ name, email, password, config }) {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  if (!name || !normalizedEmail || !password) {
    throw new Error("Name, email, and password are required.");
  }

  const existingUser = await retryOnSqliteTimeout(() =>
    prisma.user.findUnique({
      where: { email: normalizedEmail },
    }),
  );

  if (existingUser) {
    throw new Error("Email is already registered.");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
    },
  });

  return {
    token: issueToken(user, config),
    user: sanitizeUser(user),
  };
}

async function loginUser({ email, password, config }) {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  const user = await retryOnSqliteTimeout(() =>
    prisma.user.findUnique({
      where: { email: normalizedEmail },
    }),
  );

  if (!user) {
    throw new Error("Invalid email or password.");
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    throw new Error("Invalid email or password.");
  }

  return {
    token: issueToken(user, config),
    user: sanitizeUser(user),
  };
}

async function resetPassword({ email, password }) {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  const user = await retryOnSqliteTimeout(() =>
    prisma.user.findUnique({
      where: { email: normalizedEmail },
    }),
  );

  if (!user) {
    throw new Error("User not found.");
  }

  if (!password) {
    throw new Error("Password is required.");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await retryOnSqliteTimeout(() =>
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    }),
  );

  return sanitizeUser(user);
}

async function resetPasswordById({ userId, password }) {
  if (!userId) {
    throw new Error("User ID is required.");
  }

  if (!password) {
    throw new Error("Password is required.");
  }

  const user = await retryOnSqliteTimeout(() =>
    prisma.user.findUnique({
      where: { id: userId },
    }),
  );

  if (!user) {
    throw new Error("User not found.");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await retryOnSqliteTimeout(() =>
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    }),
  );

  return sanitizeUser(user);
}

async function getUserFromToken(token, config) {
  if (!token) {
    return null;
  }

  const payload = jwt.verify(token, config.jwtSecret);
  const user = await retryOnSqliteTimeout(() =>
    prisma.user.findUnique({
      where: { id: payload.sub },
    }),
  );

  return user ? sanitizeUser(user) : null;
}

function createAuthMiddleware(config, { allowApiKey = true } = {}) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      const bearerValue = header.startsWith("Bearer ") ? header.slice(7) : null;
      const headerApiKey =
        req.headers["x-api-key"] ||
        req.headers["x-wanie-api-key"] ||
        req.headers["x-openwa-api-key"] ||
        null;
      const apiKey = allowApiKey
        ? headerApiKey ||
          (String(bearerValue || "").startsWith("wanie_live_") ||
          String(bearerValue || "").startsWith("owa_live_")
            ? bearerValue
            : null)
        : null;
      const token = apiKey ? null : bearerValue;

      if (!token && !apiKey) {
        return res.status(401).json({ error: "Authentication required." });
      }

      const user = apiKey
        ? await getUserFromApiKey(apiKey)
        : await getUserFromToken(token, config);
      if (!user) {
        return res
          .status(401)
          .json({ error: apiKey ? "Invalid API key." : "Invalid token." });
      }

      req.user = user;
      return next();
    } catch (error) {
      if (isSqliteTimeoutError(error)) {
        return res
          .status(503)
          .json({ error: "Database is busy. Please try again." });
      }

      return res.status(401).json({ error: error.message });
    }
  };
}

function authMiddleware(config) {
  return createAuthMiddleware(config, { allowApiKey: true });
}

function dashboardAuthMiddleware(config) {
  return createAuthMiddleware(config, { allowApiKey: false });
}

module.exports = {
  authMiddleware,
  dashboardAuthMiddleware,
  getUserFromToken,
  isSqliteTimeoutError,
  retryOnSqliteTimeout,
  loginUser,
  registerUser,
  resetPassword,
  resetPasswordById,
  sanitizeUser,
};
