const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { prisma } = require("../database/client");
const { knowledgeDir } = require("../utils/paths");
const crmService = require("./crm-service");
const embeddingService = require("./embedding-service");

const supportedPlainTextTypes = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "application/csv",
  "application/json",
]);

const supportedImageTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
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
  if (normalized.length <= size) return [normalized];

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

    if (end >= normalized.length) break;

    const step = Math.max(content.length - overlap, Math.floor(size * 0.5), 1);
    const nextIndex = index + step;
    if (nextIndex <= index) break;
    index = nextIndex;
  }

  return chunks;
}

function formatCsvCell(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function readCsvAsText(filePath) {
  const xlsx = require("xlsx");
  const workbook = xlsx.readFile(filePath, { raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  if (!rows.length) return "";

  const headers = rows[0].map(formatCsvCell);
  const dataRows = rows.slice(1).filter((row) =>
    row.some((cell) => formatCsvCell(cell)),
  );

  return dataRows
    .map((row, rowIndex) => {
      const fields = headers
        .map((header, index) => {
          const key = header || `Kolom ${index + 1}`;
          const value = formatCsvCell(row[index]);
          return value ? `${key}: ${value}` : null;
        })
        .filter(Boolean);

      return `Baris ${rowIndex + 1}\n${fields.join("\n")}`;
    })
    .join("\n\n");
}

function tokenize(text) {
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
  const expanded = [];

  for (const token of tokens) {
    expanded.push(token);
    if (token.endsWith("nya") && token.length > 5) {
      expanded.push(token.slice(0, -3));
    }
    if (token.includes("bayar") || token.includes("payment")) {
      expanded.push("bayar", "pembayaran", "payment");
    }
    if (token.includes("qris") || token === "qr") {
      expanded.push("qris", "qr");
    }
  }

  return expanded.filter((item) => item.length >= 3);
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

function isCsvDocument(document) {
  const mimeType = String(document?.mimeType || "").toLowerCase();
  const name = String(document?.originalName || document?.fileName || "")
    .toLowerCase()
    .trim();
  return mimeType.includes("csv") || name.endsWith(".csv");
}

function shouldPreferCsv(queryTerms) {
  const csvIntentTerms = new Set([
    "booking",
    "cleaning",
    "harga",
    "layanan",
    "order",
    "pesan",
    "berapa",
    "biaya",
    "durasi",
    "kamar",
    "mandi",
    "dapur",
    "rumah",
  ]);
  return queryTerms.some((term) => csvIntentTerms.has(term));
}

function hasPaymentIntent(queryTerms, query) {
  const text = String(query || "").toLowerCase();
  return (
    /\b(qris|qr|bayar|pembayaran|payment|transfer|rekening|metode\s+bayar|metode\s+pembayaran|bayarnya|pembayarannya)\b/i.test(
      text,
    ) ||
    queryTerms.some((term) =>
      [
        "qris",
        "bayar",
        "pembayaran",
        "payment",
        "transfer",
        "rekening",
        "bayarnya",
        "pembayarannya",
      ].includes(term),
    )
  );
}

function hasPriceIntent(queryTerms, query) {
  const text = String(query || "").toLowerCase();
  return (
    /\b(price|pricelist|harga|tarif|biaya|paket|rate|rates|berapa)\b/i.test(
      text,
    ) ||
    queryTerms.some((term) =>
      ["price", "pricelist", "harga", "tarif", "biaya", "paket", "rate", "berapa"].includes(term),
    )
  );
}

function inferImageAssetCategory(chunk) {
  const metadata = chunk?.metadata || {};
  if (metadata.assetCategory) {
    return String(metadata.assetCategory).toLowerCase();
  }

  const text = [
    chunk?.document?.originalName,
    chunk?.document?.title,
    chunk?.document?.fileName,
    chunk?.content,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const categoryMatch = text.match(/image category:\s*([a-z0-9_-]+)/i);
  if (categoryMatch) {
    return categoryMatch[1].toLowerCase();
  }

  if (/\b(qris|qr|payment|pembayaran|bayar|transfer|rekening)\b/i.test(text)) {
    return "payment_qris";
  }
  if (/\b(price|pricelist|harga|tarif|biaya|paket|rate)\b/i.test(text)) {
    return "pricelist";
  }
  if (/\b(menu|katalog|catalog|produk|product|layanan|service|brosur|brochure)\b/i.test(text)) {
    return "catalog";
  }

  return "image";
}

function isImageKnowledgeChunk(chunk) {
  const metadata = chunk?.metadata || {};
  const mimeType = String(chunk?.document?.mimeType || metadata.mimeType || "")
    .toLowerCase();
  return (
    metadata.mediaType === "image" ||
    mimeType.startsWith("image/") ||
    String(chunk?.content || "").toLowerCase().includes("type: image")
  );
}

function imageIntentBoost(queryTerms, query, chunk) {
  const content = String(chunk?.content || "").toLowerCase();
  const isImage = isImageKnowledgeChunk(chunk);

  if (!isImage) return 0;

  const category = inferImageAssetCategory(chunk);

  if (hasPaymentIntent(queryTerms, query) && category === "payment_qris") {
    return 1.5;
  }

  if (hasPriceIntent(queryTerms, query) && category === "pricelist") {
    return 1.2;
  }

  return 0;
}

function readPlainText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function isImageKnowledgeFile(file) {
  const mimeType = String(file?.mimetype || file?.mimeType || "").toLowerCase();
  const ext = path.extname(file?.originalname || file?.filename || "")
    .toLowerCase()
    .trim();
  return (
    supportedImageTypes.has(mimeType) ||
    [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)
  );
}

function buildImageKnowledgeText(file) {
  const originalName = sanitizeUnicodeText(
    file.originalname || file.filename || "image",
  );
  const baseName = sanitizeUnicodeText(
    path.basename(originalName, path.extname(originalName)),
  );
  const normalizedTitle = baseName.replace(/[-_]+/g, " ").toLowerCase();
  let assetCategory = "image";
  let usage =
    "Use this image as a customer-facing attachment only when the customer asks for this exact visual reference or when the request clearly matches the image title or filename.";
  let keywords = normalizedTitle;

  if (/\b(qris|qr|payment|pembayaran|bayar|transfer|rekening|bank|ewallet|e-wallet|dana|ovo|gopay|shopeepay)\b/i.test(normalizedTitle)) {
    assetCategory = "payment_qris";
    usage =
      "Use this image only when the customer asks for QRIS, QR code payment, payment method, payment proof target, transfer/payment details, or how to pay. Do not use this image for pricelist, catalog, menu, product list, or service price questions.";
    keywords = `${normalizedTitle} qris qr code pembayaran bayar payment transfer metode pembayaran`;
  } else if (/\b(price|pricelist|price list|harga|tarif|biaya|paket|rate|rates)\b/i.test(normalizedTitle)) {
    assetCategory = "pricelist";
    usage =
      "Use this image only when the customer asks for pricelist, prices, tariffs, service fees, package prices, rates, or cost information. Do not use this image for QRIS, payment method, transfer, or payment code questions.";
    keywords = `${normalizedTitle} pricelist price list harga tarif biaya paket rate`;
  } else if (/\b(menu|katalog|catalog|catalogue|produk|product|layanan|service|brosur|brochure)\b/i.test(normalizedTitle)) {
    assetCategory = "catalog";
    usage =
      "Use this image only when the customer asks for a menu, catalog, product list, service list, brochure, or visual list that matches this image title. Do not use this image for payment QRIS unless the title clearly says it is payment-related.";
    keywords = `${normalizedTitle} menu katalog catalog produk layanan brosur brochure`;
  }

  return normalizeText(
    [
      `Image knowledge asset: ${originalName}`,
      `Title: ${baseName}`,
      `Type: image`,
      `Image category: ${assetCategory}`,
      usage,
      `Search keywords: ${keywords}`,
    ].join("\n"),
  );
}

function normalizeKnowledgeFileName(value, fallback = "knowledge.md") {
  const raw = sanitizeUnicodeText(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const name = raw || fallback;
  return path.extname(name) ? name : `${name}.md`;
}

function resolveKnowledgeFilePath(document) {
  const filePath = path.resolve(knowledgeDir, document.relativePath || "");
  const knowledgeRoot = path.resolve(knowledgeDir);
  if (
    !filePath.startsWith(`${knowledgeRoot}${path.sep}`) ||
    !fs.existsSync(filePath)
  ) {
    throw new Error("Stored knowledge file is missing.");
  }
  return filePath;
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

  if (ext === ".csv" || mimeType === "text/csv" || mimeType === "application/csv") {
    return readCsvAsText(file.path);
  }

  if (
    supportedPlainTextTypes.has(mimeType) ||
    [".txt", ".json", ".md"].includes(ext)
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

  const intentResults = chunks
    .map((chunk) => {
      const boost = imageIntentBoost(queryTerms, query, chunk);
      if (!boost) return null;
      return {
        id: chunk.id,
        documentId: chunk.documentId,
        documentTitle: chunk.document.title,
        fileName: chunk.document.originalName,
        mimeType: chunk.document.mimeType,
        metadata: chunk.metadata || null,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        score: boost,
        searchMode: "image-intent",
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, take);

  if (intentResults.length) return intentResults;

  if (canUseVector) {
    const vectorResults = chunks
      .map((chunk) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        documentTitle: chunk.document.title,
        fileName: chunk.document.originalName,
        mimeType: chunk.document.mimeType,
        metadata: chunk.metadata || null,
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

  const preferCsv = shouldPreferCsv(queryTerms);
  const keywordResults = chunks
    .map((chunk) => {
      const baseScore = scoreChunk(queryTerms, chunk.content);
      const csvBoost = preferCsv && isCsvDocument(chunk.document) ? 0.35 : 0;
      return {
        id: chunk.id,
        documentId: chunk.documentId,
        documentTitle: chunk.document.title,
        fileName: chunk.document.originalName,
        mimeType: chunk.document.mimeType,
        metadata: chunk.metadata || null,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        score: baseScore + csvBoost,
        searchMode: csvBoost ? "keyword+csv-priority" : "keyword",
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, take);

  if (keywordResults.length) return keywordResults;

  return chunks
    .filter((chunk) => !isImageKnowledgeChunk(chunk))
    .slice(0, take)
    .map((chunk) => ({
    id: chunk.id,
    documentId: chunk.documentId,
    documentTitle: chunk.document.title,
    fileName: chunk.document.originalName,
    mimeType: chunk.document.mimeType,
    metadata: chunk.metadata || null,
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    score: 0,
    searchMode: "recent",
  }));
}

async function createDocumentFromUpload(userId, file) {
  if (!file) throw new Error("File is required.");

  await replaceExistingDocumentByOriginalName(userId, file.originalname);

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
    const isImageAsset = isImageKnowledgeFile(file);
    const text = isImageAsset
      ? buildImageKnowledgeText(file)
      : normalizeText(await extractText(file));
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
                mediaType: isImageAsset ? "image" : undefined,
                assetCategory: isImageAsset
                  ? text.match(/Image category:\s*([^\n]+)/i)?.[1] || "image"
                  : undefined,
                relativePath: isImageAsset ? relativePath : undefined,
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

async function indexTextForDocument(userId, document, text, metadata = {}) {
  const normalizedText = normalizeText(text);
  const chunks = chunkText(normalizedText);

  if (!chunks.length) {
    await retryOnSqliteTimeout(() =>
      prisma.$transaction([
        prisma.knowledgeChunk.deleteMany({
          where: { userId, documentId: document.id },
        }),
        prisma.knowledgeDocument.update({
          where: { id: document.id },
          data: {
            status: "failed",
            error: "No extractable text found.",
            textLength: normalizedText.length,
          },
        }),
      ]),
    );
    return;
  }

  const settings = await crmService.getSettings(userId);
  const embeddedChunks = await embeddingService
    .embedTexts(userId, chunks, { settings })
    .catch(() => []);

  await retryOnSqliteTimeout(() =>
    prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({
        where: { userId, documentId: document.id },
      }),
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
            fileName: sanitizeUnicodeText(document.originalName || document.fileName),
            mimeType: document.mimeType || null,
            ...metadata,
          },
        })),
      }),
      prisma.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: "ready",
          error: null,
          textLength: normalizedText.length,
          size: Buffer.byteLength(normalizedText, "utf8"),
        },
      }),
    ]),
  );
}

async function createDocumentFromText(userId, payload = {}) {
  const content = sanitizeUnicodeText(payload.content || payload.text || "");
  if (!content.trim()) throw new Error("content is required.");

  const originalName = normalizeKnowledgeFileName(
    payload.originalName || payload.fileName || payload.title,
  );
  const title = sanitizeUnicodeText(payload.title || originalName);

  await replaceExistingDocumentByOriginalName(userId, originalName);

  const fileName = `${crypto.randomUUID()}${path.extname(originalName) || ".md"}`;
  const filePath = path.join(knowledgeDir, fileName);
  const normalizedContent = normalizeText(content);
  fs.writeFileSync(filePath, normalizedContent, "utf8");

  const document = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.create({
      data: {
        userId,
        title,
        fileName,
        originalName,
        mimeType: "text/markdown",
        size: Buffer.byteLength(normalizedContent, "utf8"),
        relativePath: path.relative(knowledgeDir, filePath),
        status: "processing",
      },
    }),
  );

  await indexTextForDocument(userId, document, normalizedContent, {
    source: "assistant_chat",
  });

  const updated = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findUnique({
      where: { id: document.id },
      include: { _count: { select: { chunks: true } } },
    }),
  );
  return sanitizeDocument(updated);
}

async function findDocumentForEdit(userId, selector = {}) {
  const documentId = String(selector.documentId || selector.id || "").trim();
  if (documentId) {
    return retryOnSqliteTimeout(() =>
      prisma.knowledgeDocument.findFirst({ where: { id: documentId, userId } }),
    );
  }

  const name = sanitizeUnicodeText(
    selector.originalName || selector.fileName || selector.title || selector.name || "",
  );
  if (!name) return null;

  const exact = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findFirst({
      where: {
        userId,
        OR: [{ originalName: name }, { title: name }, { fileName: name }],
      },
      orderBy: { updatedAt: "desc" },
    }),
  );
  if (exact) return exact;

  const documents = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    }),
  );
  const needle = name.toLowerCase();
  return (
    documents.find((document) =>
      [document.originalName, document.title, document.fileName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    ) || null
  );
}

async function getDocumentText(userId, selector = {}) {
  const document = await findDocumentForEdit(userId, selector);
  if (!document) throw new Error("Knowledge document not found.");
  const filePath = resolveKnowledgeFilePath(document);
  const content = await extractText({
    path: filePath,
    filename: document.fileName,
    originalname: document.originalName || document.fileName,
    mimetype: document.mimeType || "application/octet-stream",
    size: document.size || 0,
  });

  return {
    document: sanitizeDocument(document),
    content: normalizeText(content),
  };
}

async function getDocumentDownload(userId, documentId) {
  const document = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findFirst({ where: { id: documentId, userId } }),
  );
  if (!document) throw new Error("Knowledge document not found.");

  return {
    document: sanitizeDocument(document),
    filePath: resolveKnowledgeFilePath(document),
    fileName: document.originalName || document.fileName || "knowledge-document",
    mimeType: document.mimeType || "application/octet-stream",
  };
}

async function updateDocumentFromText(userId, selector = {}, payload = {}) {
  const document = await findDocumentForEdit(userId, selector);
  if (!document) throw new Error("Knowledge document not found.");

  const findText = sanitizeUnicodeText(
    payload.find || payload.findText || payload.oldText || "",
  );
  const replaceText = sanitizeUnicodeText(
    payload.replace || payload.replaceText || payload.newText || "",
  );
  const nextContent = sanitizeUnicodeText(payload.content || payload.text || "");
  if (!nextContent.trim() && !(findText && replaceText)) {
    throw new Error("content is required.");
  }

  const mode = String(payload.mode || "replace").toLowerCase();
  const needsCurrent = mode === "append" || mode === "patch" || findText;
  const current = needsCurrent
    ? await getDocumentText(userId, { id: document.id })
    : null;
  let normalizedContent;

  if (findText) {
    const currentContent = current.content || "";
    if (!currentContent.includes(findText)) {
      throw new Error("find text was not found in the knowledge document.");
    }
    normalizedContent = normalizeText(currentContent.replace(findText, replaceText));
  } else if (mode === "append") {
    normalizedContent = normalizeText(`${current.content}\n\n${nextContent}`);
  } else {
    normalizedContent = normalizeText(nextContent);
  }

  const filePath = resolveKnowledgeFilePath(document);
  fs.writeFileSync(filePath, normalizedContent, "utf8");

  const title = payload.title ? sanitizeUnicodeText(payload.title) : document.title;
  const originalName = payload.originalName
    ? normalizeKnowledgeFileName(payload.originalName)
    : document.originalName;

  const updatedDocument = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: {
        title,
        originalName,
        mimeType: "text/markdown",
        status: "processing",
        error: null,
        size: Buffer.byteLength(normalizedContent, "utf8"),
      },
    }),
  );

  await indexTextForDocument(userId, updatedDocument, normalizedContent, {
    source: "assistant_chat",
    editMode: mode,
  });

  const result = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findUnique({
      where: { id: document.id },
      include: { _count: { select: { chunks: true } } },
    }),
  );
  return sanitizeDocument(result);
}

async function replaceExistingDocumentByOriginalName(userId, originalName) {
  const normalizedName = sanitizeUnicodeText(originalName);
  if (!normalizedName) return [];

  const documents = await retryOnSqliteTimeout(() =>
    prisma.knowledgeDocument.findMany({
      where: {
        userId,
        originalName: normalizedName,
      },
    }),
  );

  if (!documents.length) return [];

  await retryOnSqliteTimeout(() =>
    prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({
        where: {
          userId,
          documentId: {
            in: documents.map((document) => document.id),
          },
        },
      }),
      prisma.knowledgeDocument.deleteMany({
        where: {
          userId,
          id: {
            in: documents.map((document) => document.id),
          },
        },
      }),
    ]),
  );

  const knowledgeRoot = path.resolve(knowledgeDir);
  for (const document of documents) {
    const filePath = path.resolve(knowledgeDir, document.relativePath || "");
    if (
      filePath.startsWith(`${knowledgeRoot}${path.sep}`) &&
      fs.existsSync(filePath)
    ) {
      fs.rmSync(filePath, { force: true });
    }
  }

  return documents.map(sanitizeDocument);
}

async function createDocumentsFromUploads(userId, files = []) {
  const documents = [];
  const latestFileByOriginalName = new Map();

  for (const file of files) {
    const key = sanitizeUnicodeText(file?.originalname);
    if (!key) continue;

    const previous = latestFileByOriginalName.get(key);
    if (
      previous?.path &&
      previous.path !== file.path &&
      fs.existsSync(previous.path)
    ) {
      fs.rmSync(previous.path, { force: true });
    }
    latestFileByOriginalName.set(key, file);
  }

  for (const file of latestFileByOriginalName.values()) {
    documents.push(await createDocumentFromUpload(userId, file));
  }

  return documents;
}

async function indexDocumentFromStoredFile(userId, document) {
  const filePath = resolveKnowledgeFilePath(document);

  const file = {
    path: filePath,
    filename: document.fileName,
    originalname: document.originalName || document.fileName,
    mimetype: document.mimeType || "application/octet-stream",
    size: document.size || 0,
  };

  const text = normalizeText(await extractText(file));
  const chunks = chunkText(text);
  if (!chunks.length) {
    await retryOnSqliteTimeout(() =>
      prisma.$transaction([
        prisma.knowledgeChunk.deleteMany({
          where: { userId, documentId: document.id },
        }),
        prisma.knowledgeDocument.update({
          where: { id: document.id },
          data: {
            status: "failed",
            error: "No extractable text found.",
            textLength: text.length,
          },
        }),
      ]),
    );
    return;
  }

  const settings = await crmService.getSettings(userId);
  const embeddedChunks = await embeddingService
    .embedTexts(userId, chunks, { settings })
    .catch(() => []);

  await retryOnSqliteTimeout(() =>
    prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({
        where: { userId, documentId: document.id },
      }),
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
            fileName: sanitizeUnicodeText(document.originalName || document.fileName),
            mimeType: document.mimeType || null,
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

  await indexDocumentFromStoredFile(userId, document);

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
  createDocumentsFromUploads,
  deleteDocument,
  reindexDocument,
  searchChunks,
  createDocumentFromText,
  updateDocumentFromText,
  getDocumentText,
  getDocumentDownload,
  chunkText,
  extractText,
};
