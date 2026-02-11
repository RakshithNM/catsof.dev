const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const path = require("node:path");

const AIRTABLE_API = "https://api.airtable.com/v0";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif"
]);

class SubmissionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "SubmissionError";
    this.statusCode = statusCode;
  }
}

function getHeader(event, name) {
  const headers = event.headers || {};
  return headers[name] || headers[name.toLowerCase()] || "";
}

function getCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = (process.env.CLOUDINARY_FOLDER || "catsof-dev").trim();

  if (!cloudName || !apiKey || !apiSecret) {
    throw new SubmissionError("Missing Cloudinary configuration.", 500);
  }

  return { cloudName, apiKey, apiSecret, folder };
}

function formatAirtableError(status, text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.error === "string") {
      return `${parsed.error} (status ${status})`;
    }
    if (parsed.error && parsed.error.type) {
      return `${parsed.error.type} (status ${status})`;
    }
  } catch {
    // Ignore parse issues and fall back to raw text.
  }
  return `${text || "Unknown Airtable error"} (status ${status})`;
}

function cleanText(value) {
  return (value || "").toString().trim();
}

function extensionFromMime(mimeType) {
  const lowerMime = (mimeType || "").toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
  };
  return map[lowerMime] || "jpg";
}

function safeFilename(filename) {
  const base = path.basename(filename || "cat-image");
  const normalized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized || "cat-image";
}

function sanitizeImageMimeType(mimeType) {
  const normalized = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(normalized)) {
    throw new SubmissionError(
      "Only JPEG, PNG, WEBP, GIF, and AVIF images are allowed."
    );
  }
  return normalized;
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map((piece) => Number(piece));
  if (parts.length !== 4 || parts.some((piece) => Number.isNaN(piece))) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase();
  return (
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  );
}

function isPrivateIpAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

async function assertPublicUrl(urlString) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new SubmissionError("photoUrl must be a valid absolute URL.");
  }

  if (!["https:", "http:"].includes(parsedUrl.protocol)) {
    throw new SubmissionError("photoUrl must start with http:// or https://.");
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localhost")
  ) {
    throw new SubmissionError("photoUrl cannot target local/internal hosts.");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new SubmissionError("photoUrl cannot target local/internal hosts.");
    }
    return parsedUrl.toString();
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SubmissionError("photoUrl host could not be resolved.");
  }
  if (!records.length) {
    throw new SubmissionError("photoUrl host could not be resolved.");
  }

  for (const record of records) {
    if (isPrivateIpAddress(record.address)) {
      throw new SubmissionError("photoUrl cannot target local/internal hosts.");
    }
  }

  return parsedUrl.toString();
}

async function readResponseWithLimit(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const fallbackBuffer = Buffer.from(await response.arrayBuffer());
    if (fallbackBuffer.length > maxBytes) {
      throw new SubmissionError("Image is too large (max 8MB).", 413);
    }
    return fallbackBuffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SubmissionError("Image is too large (max 8MB).", 413);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

function getFilenameFromUrl(urlString, mimeType) {
  const parsed = new URL(urlString);
  const fromPath = safeFilename(path.basename(parsed.pathname || ""));

  if (fromPath.includes(".")) {
    return fromPath;
  }

  return `${fromPath}.${extensionFromMime(mimeType)}`;
}

async function fetchImageFromUrl(urlString) {
  let currentUrl = cleanText(urlString);
  if (!currentUrl) {
    throw new SubmissionError("photoUrl is required when no file is uploaded.");
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    currentUrl = await assertPublicUrl(currentUrl);

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
    let response;

    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "image/*" },
        signal: abortController.signal
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new SubmissionError("Timed out while fetching photoUrl.");
      }
      throw new SubmissionError("Could not fetch photoUrl.");
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new SubmissionError("photoUrl redirect is missing location.");
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new SubmissionError(`photoUrl returned HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new SubmissionError("Image is too large (max 8MB).", 413);
    }

    const mimeType = sanitizeImageMimeType(response.headers.get("content-type") || "");
    const buffer = await readResponseWithLimit(response, MAX_IMAGE_BYTES);
    if (!buffer.length) {
      throw new SubmissionError("Fetched image is empty.");
    }

    return {
      buffer,
      mimeType,
      filename: getFilenameFromUrl(currentUrl, mimeType)
    };
  }

  throw new SubmissionError("photoUrl has too many redirects.");
}

async function parseBody(event) {
  const contentType = getHeader(event, "content-type");

  if (contentType.includes("multipart/form-data")) {
    const bodyBuffer = Buffer.from(
      event.body || "",
      event.isBase64Encoded ? "base64" : "utf8"
    );

    const parsed = await new Response(bodyBuffer, {
      headers: { "content-type": contentType }
    }).formData();

    const fields = {};
    let photoFile = null;

    for (const [key, value] of parsed.entries()) {
      if (typeof value === "string") {
        fields[key] = value;
        continue;
      }

      if (key !== "photoFile" || value.size === 0) {
        continue;
      }

      if (value.size > MAX_IMAGE_BYTES) {
        throw new SubmissionError("Uploaded image is too large (max 8MB).", 413);
      }

      const mimeType = sanitizeImageMimeType(value.type || "");
      photoFile = {
        filename: safeFilename(value.name || `upload.${extensionFromMime(mimeType)}`),
        mimeType,
        size: value.size,
        buffer: Buffer.from(await value.arrayBuffer())
      };
    }

    return { fields, photoFile };
  }

  if (contentType.includes("application/json")) {
    return {
      fields: JSON.parse(event.body || "{}"),
      photoFile: null
    };
  }

  const params = new URLSearchParams(event.body || "");
  return {
    fields: Object.fromEntries(params.entries()),
    photoFile: null
  };
}

async function uploadToCloudinary(image, cloudinaryConfig) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureParams = { timestamp: String(timestamp) };

  if (cloudinaryConfig.folder) {
    signatureParams.folder = cloudinaryConfig.folder;
  }

  const paramString = Object.keys(signatureParams)
    .sort()
    .map((key) => `${key}=${signatureParams[key]}`)
    .join("&");

  const signature = crypto
    .createHash("sha1")
    .update(`${paramString}${cloudinaryConfig.apiSecret}`)
    .digest("hex");

  const formData = new FormData();
  formData.set(
    "file",
    new Blob([image.buffer], { type: image.mimeType }),
    image.filename || `upload.${extensionFromMime(image.mimeType)}`
  );
  formData.set("api_key", cloudinaryConfig.apiKey);
  formData.set("timestamp", String(timestamp));
  if (cloudinaryConfig.folder) {
    formData.set("folder", cloudinaryConfig.folder);
  }
  formData.set("signature", signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/image/upload`,
    {
      method: "POST",
      body: formData
    }
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("Cloudinary upload failed:", text);
    throw new SubmissionError("Image upload to Cloudinary failed.", 502);
  }

  const data = await response.json();
  if (!data.secure_url) {
    throw new SubmissionError("Cloudinary response missing secure_url.", 502);
  }

  return data.secure_url;
}

async function resolveCanonicalPhotoUrl({ photoUrl, photoFile, cloudinaryConfig }) {
  if (photoFile && photoFile.buffer && photoFile.buffer.length) {
    return uploadToCloudinary(photoFile, cloudinaryConfig);
  }

  const remoteImage = await fetchImageFromUrl(photoUrl);
  return uploadToCloudinary(remoteImage, cloudinaryConfig);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME || "Cats";

  if (!token || !baseId) {
    return { statusCode: 500, body: "Missing Airtable configuration." };
  }

  let parsedBody;
  try {
    parsedBody = await parseBody(event);
  } catch (error) {
    if (error instanceof SubmissionError) {
      return { statusCode: error.statusCode, body: error.message };
    }
    return { statusCode: 400, body: "Invalid form payload." };
  }

  const { fields, photoFile } = parsedBody;

  if (fields.website) {
    return { statusCode: 303, headers: { Location: "/thanks/" }, body: "" };
  }

  const catName = cleanText(fields.catName);
  const humanName = cleanText(fields.humanName);
  const photoUrl = cleanText(fields.photoUrl);

  if (!catName || !humanName) {
    return {
      statusCode: 400,
      body: "catName and humanName are required."
    };
  }

  if (!photoFile && !photoUrl) {
    return {
      statusCode: 400,
      body: "Provide either photoFile or photoUrl."
    };
  }

  let cloudinaryConfig;
  try {
    cloudinaryConfig = getCloudinaryConfig();
  } catch (error) {
    if (error instanceof SubmissionError) {
      return { statusCode: error.statusCode, body: error.message };
    }
    return { statusCode: 500, body: "Missing Cloudinary configuration." };
  }

  let canonicalPhotoUrl;
  try {
    canonicalPhotoUrl = await resolveCanonicalPhotoUrl({
      photoUrl,
      photoFile,
      cloudinaryConfig
    });
  } catch (error) {
    if (error instanceof SubmissionError) {
      return { statusCode: error.statusCode, body: error.message };
    }
    console.error("Image normalization failed:", error);
    return { statusCode: 500, body: "Could not process image input." };
  }

  const payload = {
    fields: {
      "Cat Name": catName,
      "Human Name": humanName,
      "Developer URL": cleanText(fields.devUrl),
      "Photo URL": canonicalPhotoUrl,
      Story: cleanText(fields.story),
      Status: "Pending"
    }
  };

  try {
    const response = await fetch(
      `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableName)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const text = await response.text();
      const details = formatAirtableError(response.status, text);
      console.error(
        "Airtable write failed:",
        details,
        `(base=${baseId}, table=${tableName})`
      );

      return {
        statusCode: 500,
        headers: { "Content-Type": "text/plain" },
        body: `Could not save submission. ${details}`
      };
    }

    const acceptHeader = getHeader(event, "accept");
    if (acceptHeader.includes("application/json")) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, photoUrl: canonicalPhotoUrl })
      };
    }

    return { statusCode: 303, headers: { Location: "/thanks/" }, body: "" };
  } catch (error) {
    console.error("Airtable write failed:", error);
    return { statusCode: 500, body: "Could not save submission." };
  }
};
