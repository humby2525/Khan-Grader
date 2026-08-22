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
