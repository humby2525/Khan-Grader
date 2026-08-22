chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") });
});

const networkProbe = {
  active: false,
  startedAt: "",
  logs: [],
  maxLogs: 120
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCHOOLOGY_API_FETCH") {
    schoologyFetchJson(message.path, message.options || {}, message.schoologyConfig || {})
      .then((json) => sendResponse({ ok: true, json }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message?.type === "KHAN_NETWORK_PROBE_START") {
    networkProbe.active = true;
    networkProbe.startedAt = new Date().toISOString();
    networkProbe.logs = [];
    sendResponse({ ok: true, startedAt: networkProbe.startedAt });
    return false;
  }

  if (message?.type === "KHAN_NETWORK_PROBE_COLLECT") {
    sendResponse({
      ok: true,
      active: networkProbe.active,
      startedAt: networkProbe.startedAt,
      collectedAt: new Date().toISOString(),
      logs: networkProbe.logs
    });
    return false;
  }

  if (message?.type === "KHAN_NETWORK_PROBE_STOP") {
    networkProbe.active = false;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function schoologyFetchJson(path, options, schoologyConfig) {
  const method = options.method || "GET";
  const apiBase = String(schoologyConfig.apiBase || "https://api.schoology.com/v1").replace(/\/+$/, "");
  const url = new URL(`${apiBase}${String(path).startsWith("/") ? "" : "/"}${path}`);
  const bodyText = options.body ? JSON.stringify(options.body) : null;
  const headers = {
    Accept: "application/json",
    Authorization: await buildSchoologyAuthorizationHeader(method, url, schoologyConfig)
  };
  if (bodyText) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: bodyText
    });
  } catch (error) {
    throw new Error(`Schoology background request failed before the API responded for ${url.origin}. Confirm the dashboard says v0.9.3, reload the extension in chrome://extensions, and keep API base as https://api.schoology.com/v1. Details: ${error.message || String(error)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Schoology API ${response.status} for ${url.pathname}: ${text || response.statusText}`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function buildSchoologyAuthorizationHeader(method, url, schoologyConfig) {
  const oauthParams = {
    oauth_consumer_key: schoologyConfig.consumerKey,
    oauth_nonce: createOAuthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0"
  };
  const signature = await signOAuthRequest(method, url, oauthParams, schoologyConfig.consumerSecret);
  return "OAuth " + Object.entries({ ...oauthParams, oauth_signature: signature })
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ");
}

async function signOAuthRequest(method, url, oauthParams, consumerSecret) {
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const params = [];
  for (const [key, value] of url.searchParams.entries()) params.push([key, value]);
  for (const [key, value] of Object.entries(oauthParams)) params.push([key, value]);
  params.sort((a, b) => percentEncode(a[0]).localeCompare(percentEncode(b[0])) || percentEncode(a[1]).localeCompare(percentEncode(b[1])));

  const paramString = params.map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`).join("&");
  const signatureBase = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramString)
  ].join("&");
  const signingKey = `${percentEncode(consumerSecret)}&`;
  return hmacSha1Base64(signingKey, signatureBase);
}

async function hmacSha1Base64(key, text) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function createOAuthNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${Date.now()}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!networkProbe.active) return;
    if (!/khanacademy\.org/i.test(details.url)) return;

    const requestBodyPreview = extractRequestBody(details.requestBody);
    const record = {
      source: "chrome.webRequest.onBeforeRequest",
      type: "webRequest",
      capturedAt: new Date().toISOString(),
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      url: details.url,
      requestBodyPreview,
      requestJsonShape: parseJsonShape(requestBodyPreview)
    };

    networkProbe.logs.push(record);
    if (networkProbe.logs.length > networkProbe.maxLogs) networkProbe.logs.shift();
  },
  { urls: ["https://khanacademy.org/*", "https://*.khanacademy.org/*"] },
  ["requestBody"]
);

function extractRequestBody(requestBody) {
  if (!requestBody) return "";

  if (requestBody.formData) {
    return truncateText(JSON.stringify(requestBody.formData), 20000);
  }

  if (requestBody.raw?.length) {
    const chunks = requestBody.raw
      .map((entry) => decodeBytes(entry.bytes))
      .filter(Boolean);
    return truncateText(chunks.join(""), 20000);
  }

  if (requestBody.error) return `[requestBody error: ${requestBody.error}]`;
  return "";
}

function decodeBytes(bytes) {
  if (!bytes) return "";
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function parseJsonShape(text) {
  try {
    return summarizeJson(JSON.parse(text));
  } catch {
    return null;
  }
}

function summarizeJson(value) {
  const paths = [];
  const sample = {};
  walk(value, "$", 0);
  return { paths: paths.slice(0, 160), sample };

  function walk(current, currentPath, depth) {
    if (depth > 8 || paths.length > 240) return;
    if (Array.isArray(current)) {
      paths.push(`${currentPath}[] length=${current.length}`);
      current.slice(0, 10).forEach((item, index) => walk(item, `${currentPath}[${index}]`, depth + 1));
      return;
    }
    if (!current || typeof current !== "object") return;

    for (const [key, child] of Object.entries(current)) {
      const childPath = `${currentPath}.${key}`;
      if (/date|time|minute|duration|exercise|activity|student|learner|kaid|course|skill|score|total|report|variables|operation|query/i.test(key)) {
        paths.push(childPath);
        if (Object.keys(sample).length < 40) sample[childPath] = summarizeValue(child);
      }
      walk(child, childPath, depth + 1);
    }
  }
}

function summarizeValue(value) {
  if (Array.isArray(value)) return `[array length ${value.length}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).slice(0, 12).join(", ")}}`;
  return value;
}

function truncateText(text, maxLength) {
  const value = String(text || "");
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]` : value;
}
