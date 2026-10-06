const { PrismaClient } = require("@prisma/client");
const { databasePath, getSqliteUrl } = require("../utils/paths");

const globalKey = "__openwa_prisma__";

function getDatabaseUrl() {
  if (process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()) {
    return process.env.DATABASE_URL;
  }
  return getSqliteUrl(databasePath);
}

function getPrismaClient() {
  if (!global[globalKey]) {
    const url = getDatabaseUrl();
    global[globalKey] = new PrismaClient({
      datasources: {
        db: {
          url,
        },
      },
    });
  }
  return global[globalKey];
}

const prisma = new Proxy(
  {},
  {
    get(target, prop) {
      const client = getPrismaClient();
      const value = client[prop];
      if (typeof value === "function") {
        return value.bind(client);
      }
      return value;
    },
    has(target, prop) {
      const client = getPrismaClient();
      return prop in client;
    },
  },
);

module.exports = {
  prisma,
  getPrismaClient,
};
