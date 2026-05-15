const fs = require("fs");
const path = require("path");
const { prisma } = require("../database/client");
const { knowledgeDir } = require("../utils/paths");
const crmService = require("./crm-service");
const embeddingService = require("./embedding-service");

const supportedPlainTextTypes = new Set([
  "text/plain",
  "text/csv",
  "application/csv",
  "application/json",
]);

async function retryOnSqliteTimeout(operation) {
  let lastError = null;
  for (const delayMs of [0, 100, 250, 500]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      return await operation();
    } catch (error) {
      if (error?.code !== "P1008") throw error;
      lastError = error;
    }
  }

  throw lastError;
}

function sanitizeDocument(record) {
  if (!record) return null;
  return {
    id: record.id,
    title: record.title,
    fileName: record.fileName,
    originalName: record.originalName,
    mimeType: record.mimeType,
    size: record.size,
    status: record.status,
    error: record.error,
    textLength: record.textLength,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    chunkCount: record._count?.chunks || record.chunkCount || 0,
  };
}

function sanitizeUnicodeText(value) {
  const input = String(value || "");
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += input[index] + input[index + 1];
        index += 1;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }

    if (code === 0) {
      continue;
    }

    output += input[index];
  }

  return output;
}

function normalizeText(text) {
  return sanitizeUnicodeText(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text, { size = 1200, overlap = 200 } = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const chunks = [];
  let index = 0;
  while (index < normalized.length) {
    const end = Math.min(index + size, normalized.length);
    let slice = normalized.slice(index, end);

    if (end < normalized.length) {
      const lastBreak = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("! "),
      );
      if (lastBreak > size * 0.5) {
        slice = slice.slice(0, lastBreak + 1);
      }
    }

    const content = normalizeText(slice);
    if (content) chunks.push(content);

    const nextIndex = index + Math.max(content.length - overlap, 1);
    if (nextIndex <= index) break;
    index = nextIndex;
  }

  return chunks;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

function scoreChunk(queryTerms, content) {
  if (!queryTerms.length) return 0;
  const haystack = String(content || "").toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 1;
  }
  return score / queryTerms.length;
}

function readPlainText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

async function extractPdfText(filePath) {
  const pdfParse = require("pdf-parse");
  const buffer = fs.readFileSync(filePath);

  if (typeof pdfParse === "function") {
    const result = await pdfParse(buffer);
    return result.text || "";
  }

  if (typeof pdfParse.PDFParse === "function") {
    const parser = new pdfParse.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text || "";
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  throw new Error("Unsupported pdf-parse API.");
}

async function extractText(file) {
  const ext = path.extname(file.originalname || file.filename || "")
    .toLowerCase()
    .trim();
  const mimeType = String(file.mimetype || "").toLowerCase();

  if (
    supportedPlainTextTypes.has(mimeType) ||
    [".txt", ".csv", ".json", ".md"].includes(ext)
  ) {
    return readPlainText(file.path);
  }

  if (ext === ".xlsx" || mimeType.includes("spreadsheet")) {
    try {
      const xlsx = require("xlsx");
      const workbook = xlsx.readFile(file.path);
      return workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_csv(sheet);
        return `Sheet: ${sheetName}\n${rows}`;
      }).join("\n\n");
    } catch (error) {
      throw new Error(
        "XLSX extraction requires the optional `xlsx` package to be installed.",
      );
    }
  }

  if (ext === ".docx" || mimeType.includes("wordprocessingml")) {
    try {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ path: file.path });
      return result.value || "";
    } catch (error) {
      throw new Error(
        "DOCX extraction requires the optional `mammoth` package to be installed.",
      );
    }
  }

  if (ext === ".pdf" || mimeType === "application/pdf") {
    try {
      return extractPdfText(file.path);
    } catch (error) {
      throw new Error(
        `PDF extraction failed: ${error.message}`,
      );
    }
  }

  throw new Error(`Unsupported knowledge file type: ${file.originalname}`);
}

async function listDocuments(userId) {
  const documents = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { chunks: true } } },
    }),
  );
  return documents.map(sanitizeDocument);
}

async function getDocumentChunks(userId, documentId) {
  const document = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findFirst({ where: { id: documentId, userId } }),
  );
  if (!document) throw new Error("Knowledge document not found.");

  const chunks = await retryOnSqliteTimeout(() =>
    prisma.knowledgeChunk.findMany({
      where: { userId, documentId },
      orderBy: { chunkIndex: "asc" },
    }),
  );

  return {
    document: sanitizeDocument(document),
    chunks: chunks.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      tokenCount: chunk.tokenCount,
      metadata: chunk.metadata,
      createdAt: chunk.createdAt,
    })),
  };
}

function embeddingArray(value) {
  if (Array.isArray(value)) return value;
  return null;
}

async function searchChunks(userId, query, options = {}) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length) return [];

  const settings = options.settings || (await crmService.getSettings(userId));
  const take = Math.max(
    1,
    Math.min(Number(options.limit) || settings.maxChunks || 6, 12),
  );
  const chunks = await retryOnSqliteTimeout(() =>
    prisma.knowledgeChunk.findMany({
      where: {
        userId,
        document: {
          status: "ready",
        },
      },
      include: {
        document: true,
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  );

  const queryEmbeddings = await embeddingService
    .embedTexts(userId, [query], { settings })
    .catch(() => []);
  const queryEmbedding = queryEmbeddings[0]?.embedding || null;
  const canUseVector =
    queryEmbedding && chunks.some((chunk) => embeddingArray(chunk.embedding));

  if (canUseVector) {
    const vectorResults = chunks
      .map((chunk) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        documentTitle: chunk.document.title,
        fileName: chunk.document.originalName,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        score: embeddingService.cosineSimilarity(
          queryEmbedding,
          embeddingArray(chunk.embedding),
        ),
        searchMode: "embedding",
      }))
      .filter((item) => item.score >= settings.similarityThreshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, take);

    if (vectorResults.length) return vectorResults;
  }

  const keywordResults = chunks
    .map((chunk) => ({
      id: chunk.id,
      documentId: chunk.documentId,
      documentTitle: chunk.document.title,
      fileName: chunk.document.originalName,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      score: scoreChunk(queryTerms, chunk.content),
      searchMode: "keyword",
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, take);

  if (keywordResults.length) return keywordResults;

  return chunks.slice(0, take).map((chunk) => ({
    id: chunk.id,
    documentId: chunk.documentId,
    documentTitle: chunk.document.title,
    fileName: chunk.document.originalName,
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    score: 0,
    searchMode: "recent",
  }));
}

async function createDocumentFromUpload(userId, file) {
  if (!file) throw new Error("File is required.");

  const relativePath = path.relative(knowledgeDir, file.path);
  const document = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.create({
      data: {
        userId,
        title: sanitizeUnicodeText(file.originalname),
        fileName: sanitizeUnicodeText(file.filename),
        originalName: sanitizeUnicodeText(file.originalname),
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size || 0,
        relativePath,
        status: "processing",
      },
    }),
  );

  try {
    const text = normalizeText(await extractText(file));
    const chunks = chunkText(text);

    if (!chunks.length) {
      await retryOnSqliteTimeout(() =>
        prisma.knowledgeDocument.update({
          where: { id: document.id },
          data: {
            status: "failed",
            error: "No extractable text found.",
            textLength: text.length,
          },
        }),
      );
    } else {
      const settings = await crmService.getSettings(userId);
      const embeddedChunks = await embeddingService
        .embedTexts(userId, chunks, { settings })
        .catch(() => []);

      await retryOnSqliteTimeout(() =>
        prisma.$transaction([
          prisma.knowledgeChunk.createMany({
            data: chunks.map((content, chunkIndex) => ({
              userId,
              documentId: document.id,
              content,
              embedding: embeddedChunks[chunkIndex]?.embedding || undefined,
              embeddingModel: embeddedChunks[chunkIndex]?.model || null,
              chunkIndex,
              tokenCount: Math.ceil(content.length / 4),
              metadata: {
                fileName: sanitizeUnicodeText(file.originalname),
                mimeType: file.mimetype || null,
              },
            })),
          }),
          prisma.knowledgeDocument.update({
            where: { id: document.id },
            data: {
              status: "ready",
              error: null,
              textLength: text.length,
            },
          }),
        ]),
      );
    }
  } catch (error) {
    await retryOnSqliteTimeout(() =>
      prisma.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: "failed",
          error: error.message,
        },
      }),
    );
  }

  const updated = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findUnique({
      where: { id: document.id },
      include: { _count: { select: { chunks: true } } },
    }),
  );
  return sanitizeDocument(updated);
}

async function deleteDocument(userId, documentId) {
  const document = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findFirst({ where: { id: documentId, userId } }),
  );
  if (!document) throw new Error("Knowledge document not found.");

  await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.delete({ where: { id: documentId } }),
  );

  const filePath = path.resolve(knowledgeDir, document.relativePath || "");
  const knowledgeRoot = path.resolve(knowledgeDir);
  if (
    filePath.startsWith(`${knowledgeRoot}${path.sep}`) &&
    fs.existsSync(filePath)
  ) {
    fs.rmSync(filePath, { force: true });
  }

  return { ok: true };
}

async function reindexDocument(userId, documentId) {
  const document = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findFirst({ where: { id: documentId, userId } }),
  );
  if (!document) throw new Error("Knowledge document not found.");

  const chunks = await retryOnSqliteTimeout(() =>
    prisma.knowledgeChunk.findMany({
      where: { userId, documentId },
      orderBy: { chunkIndex: "asc" },
    }),
  );
  if (!chunks.length) return sanitizeDocument(document);

  const settings = await crmService.getSettings(userId);
  const embeddings = await embeddingService.embedTexts(
    userId,
    chunks.map((chunk) => chunk.content),
    { settings },
  );
  if (!embeddings.length) {
    throw new Error("Embedding provider is not configured.");
  }

  await retryOnSqliteTimeout(() =>
    prisma.$transaction(
      chunks.map((chunk, index) =>
        prisma.knowledgeChunk.update({
          where: { id: chunk.id },
          data: {
            embedding: embeddings[index]?.embedding || undefined,
            embeddingModel: embeddings[index]?.model || null,
          },
        }),
      ),
    ),
  );

  const updated = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      include: { _count: { select: { chunks: true } } },
    }),
  );
  return sanitizeDocument(updated);
}

module.exports = {
  listDocuments,
  getDocumentChunks,
  createDocumentFromUpload,
  deleteDocument,
  reindexDocument,
  searchChunks,
  chunkText,
  extractText,
};
