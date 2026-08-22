const BUILD_VERSION = "0.2.0";
const STORAGE_KEY = "khanGrader.lastCapture";

const elements = {};
let lastCapture = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  for (const element of document.querySelectorAll("[id]")) {
    elements[element.id] = element;
  }

  elements.build.textContent = `v${BUILD_VERSION}`;
  elements.captureButton.addEventListener("click", captureCurrentTab);
  elements.openKhanButton.addEventListener("click", () => chrome.tabs.create({ url: "https://classroom.khanacademy.org/" }));
  elements.downloadButton.addEventListener("click", downloadCsv);
  elements.copyDiagnosticsButton.addEventListener("click", copyDiagnostics);

  setDefaultWeek();

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY]) {
    lastCapture = stored[STORAGE_KEY];
    renderCapture(lastCapture);
    setStatus(`Loaded previous capture with ${lastCapture.rows.length} row(s).`);
  }
}

function setDefaultWeek() {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  elements.weekStart.value = toDateInput(monday);
  elements.weekEnd.value = toDateInput(sunday);
}

async function captureCurrentTab() {
  const tab = await findKhanTab();
  if (!tab?.id) {
    setError("Open the Khan Activity Report in this Chrome window, set the date range, then capture.");
    return;
  }

  setStatus(`Reading Khan report frames from ${tab.title || tab.url}...`);

  try {
    const capture = await readKhanTab(tab);
    lastCapture = {
      ...capture,
      expectedWeekStart: elements.weekStart.value,
      expectedWeekEnd: elements.weekEnd.value,
      capturedAt: new Date().toISOString()
    };

    await chrome.storage.local.set({ [STORAGE_KEY]: lastCapture });
    renderCapture(lastCapture);

    if (lastCapture.rows.length || lastCapture.activityRows.length) {
      setStatus(`Captured ${lastCapture.rows.length} total row(s) and ${lastCapture.activityRows.length} activity row(s). Khan page type: ${lastCapture.pageKind}.`);
    } else {
      setError("Khan was readable, but no total rows or activity rows were found. Check Diagnostics and make sure the activity information is visible.");
    }
  } catch (error) {
    setError(error.message || String(error));
  }
}

async function findKhanTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isKhanTab(activeTab)) return activeTab;

  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(isKhanTab)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

function isKhanTab(tab) {
  return Boolean(tab?.id && /khanacademy\.org/i.test(tab.url || ""));
}

async function readKhanTab(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ["src/content/khanCapture.js"]
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      if (typeof globalThis.__KHAN_GRADER_CAPTURE__ !== "function") return null;
      return globalThis.__KHAN_GRADER_CAPTURE__();
    }
  });

  const frameReports = results
    .map((item, index) => ({ frameIndex: index + 1, ...item.result }))
    .filter((report) => report.url);

  if (!frameReports.length) {
    throw new Error("No Khan frames responded. Refresh the Khan tab and try again.");
  }

  const bestReport = frameReports
    .slice()
    .sort((a, b) => ((b.activityRows?.length || 0) + (b.rows?.length || 0)) - ((a.activityRows?.length || 0) + (a.rows?.length || 0)))[0];

  return {
    pageUrl: tab.url,
    pageTitle: tab.title,
    bestFrameUrl: bestReport.url,
    bestFrameTitle: bestReport.title,
    pageKind: bestReport.pageKind || "unknown",
    dateRange: bestReport.dateRange || "",
    rows: dedupeRows(frameReports.flatMap((report) => report.rows || [])),
    activityRows: dedupeActivityRows(frameReports.flatMap((report) => report.activityRows || [])),
    frameReports: frameReports.map((report) => ({
      frameIndex: report.frameIndex,
      url: report.url,
      title: report.title,
      rowCount: report.rows?.length || 0,
      activityRowCount: report.activityRows?.length || 0,
      pageKind: report.pageKind || "unknown",
      dateRange: report.dateRange || "",
      diagnostics: report.diagnostics,
      textSample: report.textSample
    }))
  };
}

function renderCapture(capture) {
  elements.rowCount.textContent = String(capture.rows.length);
  elements.activityRowCount.textContent = String(capture.activityRows?.length || 0);
  elements.dateRange.textContent = capture.dateRange || "Not detected";
  elements.bestFrame.textContent = capture.bestFrameUrl || "Not detected";

  elements.downloadButton.disabled = capture.rows.length === 0 && (capture.activityRows?.length || 0) === 0;
  elements.copyDiagnosticsButton.disabled = false;

  renderTable(capture.rows);
  renderActivityTable(capture.activityRows || []);
  elements.diagnostics.textContent = formatDiagnostics(capture);
}

function renderTable(rows) {
  elements.table.className = rows.length ? "table" : "table empty";
  elements.table.innerHTML = "";

  if (!rows.length) {
    elements.table.textContent = "No rows captured.";
    return;
  }

  const header = document.createElement("div");
  header.className = "row header";
  header.innerHTML = "<div>Student</div><div>Minutes</div><div>Source</div>";
  elements.table.append(header);

  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "row";
    line.innerHTML = `
      <div>${escapeHtml(row.name)}</div>
      <div>${escapeHtml(row.minutes)}</div>
      <div class="source">${escapeHtml(row.sourceText || "")}</div>
    `;
    elements.table.append(line);
  }
}

function renderActivityTable(rows) {
  elements.activityTable.className = rows.length ? "table" : "table empty";
  elements.activityTable.innerHTML = "";

  if (!rows.length) {
    elements.activityTable.textContent = "No activity details captured.";
    return;
  }

  const header = document.createElement("div");
  header.className = "row activity header";
  header.innerHTML = "<div>Date</div><div>Activity</div><div>Minutes</div><div>Source</div>";
  elements.activityTable.append(header);

  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "row activity";
    line.innerHTML = `
      <div>${escapeHtml(row.dateText)}</div>
      <div>${escapeHtml(row.activity)}</div>
      <div>${escapeHtml(row.minutes)}</div>
      <div class="source">${escapeHtml(row.sourceText || "")}</div>
    `;
    elements.activityTable.append(line);
  }
}

function formatDiagnostics(capture) {
  return JSON.stringify({
    build: BUILD_VERSION,
    capturedAt: capture.capturedAt,
    expectedWeekStart: capture.expectedWeekStart,
    expectedWeekEnd: capture.expectedWeekEnd,
    pageUrl: capture.pageUrl,
    pageTitle: capture.pageTitle,
    bestFrameUrl: capture.bestFrameUrl,
    bestFrameTitle: capture.bestFrameTitle,
    pageKind: capture.pageKind,
    detectedDateRange: capture.dateRange,
    rowCount: capture.rows.length,
    activityRowCount: capture.activityRows?.length || 0,
    activityRows: capture.activityRows || [],
    framesChecked: capture.frameReports.length,
    frameReports: capture.frameReports
  }, null, 2);
}

async function copyDiagnostics() {
  if (!lastCapture) return;
  await navigator.clipboard.writeText(formatDiagnostics(lastCapture));
  setStatus("Diagnostics copied.");
}

function downloadCsv() {
  if (!lastCapture) return;

  const activityRows = lastCapture.activityRows || [];
  const csv = activityRows.length
    ? [
      "Expected Week Start,Expected Week End,Khan Date Range,Date,Activity,Minutes,Source",
      ...activityRows.map((row) => [
        lastCapture.expectedWeekStart,
        lastCapture.expectedWeekEnd,
        lastCapture.dateRange,
        row.dateText,
        row.activity,
        row.minutes,
        row.sourceText || ""
      ].map(csvCell).join(","))
    ].join("\n")
    : [
      "Expected Week Start,Expected Week End,Khan Date Range,Student,Minutes,Source",
      ...lastCapture.rows.map((row) => [
      lastCapture.expectedWeekStart,
      lastCapture.expectedWeekEnd,
      lastCapture.dateRange,
      row.name,
      row.minutes,
      row.sourceText || ""
      ].map(csvCell).join(","))
    ].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `khan-minutes-${lastCapture.expectedWeekStart || "capture"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function dedupeActivityRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = [
      String(row.dateText || "").toLowerCase().trim(),
      normalizeName(row.activity),
      row.minutes
    ].join("|");
    const current = byKey.get(key);
    if (!current || row.sourceText.length < current.sourceText.length) byKey.set(key, row);
  }
  return Array.from(byKey.values()).sort((a, b) => (a.dateText || "").localeCompare(b.dateText || "") || a.activity.localeCompare(b.activity));
}

function dedupeRows(rows) {
  const byName = new Map();
  for (const row of rows) {
    const key = normalizeName(row.name);
    if (!key) continue;
    const current = byName.get(key);
    if (!current || row.sourceText.length < current.sourceText.length) byName.set(key, row);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(message) {
  elements.status.className = "status";
  elements.status.textContent = message;
}

function setError(message) {
  elements.status.className = "status error";
  elements.status.textContent = message;
}
