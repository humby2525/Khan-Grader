const BUILD_VERSION = "0.6.0";
const STORAGE_KEY = "khanGrader.lastCapture";

const elements = {};
let lastCapture = null;
let lastNetworkProbe = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  for (const element of document.querySelectorAll("[id]")) {
    elements[element.id] = element;
  }

  elements.build.textContent = `v${BUILD_VERSION}`;
  elements.captureApiButton.addEventListener("click", captureCurrentStudentViaApi);
  elements.captureClassApiButton.addEventListener("click", captureClassViaApi);
  elements.captureButton.addEventListener("click", captureCurrentTab);
  elements.startNetworkProbeButton.addEventListener("click", startNetworkProbe);
  elements.collectNetworkProbeButton.addEventListener("click", collectNetworkProbe);
  elements.openKhanButton.addEventListener("click", () => chrome.tabs.create({ url: "https://classroom.khanacademy.org/" }));
  elements.downloadButton.addEventListener("click", downloadCsv);
  elements.copyDiagnosticsButton.addEventListener("click", copyDiagnostics);
  elements.copyNetworkProbeButton.addEventListener("click", copyNetworkProbe);

  setDefaultWeek();

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY]) {
    lastCapture = stored[STORAGE_KEY];
    renderCapture(lastCapture);
    setStatus("Loaded previous capture.");
  }
}

async function startNetworkProbe() {
  const tab = await findKhanTab();
  if (!tab?.id) {
    setError("Open the Khan Individual Student Report tab before starting the network probe.");
    return;
  }

  setStatus("Installing Khan network probe...");
  const backgroundProbe = await chrome.runtime.sendMessage({ type: "KHAN_NETWORK_PROBE_START" });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: "MAIN",
    func: installKhanNetworkProbeInPage
  });

  const installedFrames = results.filter((item) => item.result?.ok).length;
  elements.networkProbe.textContent = `Network probe installed in ${installedFrames} Khan frame(s).\nChrome webRequest probe started: ${backgroundProbe?.startedAt || "unknown"}.\n\nNow go to the Khan tab, change the date filter, wait for the report to refresh, then click Collect Network Probe.`;
  elements.copyNetworkProbeButton.disabled = true;
  setStatus("Network probe started. Change the Khan date filter, then collect.");
}

async function collectNetworkProbe() {
  const tab = await findKhanTab();
  if (!tab?.id) {
    setError("Open the Khan Individual Student Report tab before collecting the network probe.");
    return;
  }

  setStatus("Collecting Khan network probe...");
  const backgroundProbe = await chrome.runtime.sendMessage({ type: "KHAN_NETWORK_PROBE_COLLECT" });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: "MAIN",
    func: collectKhanNetworkProbeFromPage
  });

  const frameLogs = results
    .map((item, index) => ({
      frameIndex: index + 1,
      frameUrl: item.result?.url || "",
      logs: item.result?.logs || []
    }))
    .filter((frame) => frame.frameUrl || frame.logs.length);

  const pageLogs = frameLogs.flatMap((frame) => frame.logs.map((log) => ({
    frameIndex: frame.frameIndex,
    frameUrl: frame.frameUrl,
    ...log,
    analysis: analyzeNetworkLog(log)
  })));

  const extensionLogs = (backgroundProbe?.logs || []).map((log) => ({
    ...log,
    frameIndex: log.frameId,
    frameUrl: "",
    analysis: analyzeNetworkLog(log)
  }));

  const logs = [...extensionLogs, ...pageLogs];

  lastNetworkProbe = {
    build: BUILD_VERSION,
    collectedAt: new Date().toISOString(),
    pageUrl: tab.url,
    pageTitle: tab.title,
    backgroundProbe: {
      active: Boolean(backgroundProbe?.active),
      startedAt: backgroundProbe?.startedAt || "",
      collectedAt: backgroundProbe?.collectedAt || "",
      logCount: backgroundProbe?.logs?.length || 0
    },
    totalLogs: logs.length,
    candidateLogs: logs.filter((log) => log.analysis.isCandidate),
    allLogs: logs
  };

  elements.networkProbe.textContent = JSON.stringify(lastNetworkProbe, null, 2);
  elements.copyNetworkProbeButton.disabled = false;

  const withDates = lastNetworkProbe.candidateLogs.filter((log) => log.analysis.dateHints.length);
  setStatus(`Collected ${logs.length} network log(s), ${lastNetworkProbe.candidateLogs.length} likely Khan report candidate(s), ${withDates.length} with date hints.`);
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

    if (hasStudentSummary(lastCapture.studentSummary)) {
      setStatus(`Captured ${lastCapture.studentSummary.studentName || "current student"}: ${formatMinutes(lastCapture.studentSummary.exerciseMinutes)} exercises, ${formatMinutes(lastCapture.studentSummary.timeOnTaskMinutes)} time on task.`);
    } else if (lastCapture.rows.length || lastCapture.activityRows.length) {
      setStatus(`Captured fallback data: ${lastCapture.rows.length} total row(s) and ${lastCapture.activityRows.length} activity row(s). Khan page type: ${lastCapture.pageKind}.`);
    } else {
      setError("Khan was readable, but the Individual Student Report metrics were not found. Copy Diagnostics after confirming Exercises and Time on task are visible.");
    }
  } catch (error) {
    setError(error.message || String(error));
  }
}

async function captureCurrentStudentViaApi() {
  const startDate = elements.weekStart.value;
  const endDate = elements.weekEnd.value;
  if (!startDate || !endDate) {
    setError("Choose a start date and end date before using the Khan API capture.");
    return;
  }
  if (startDate > endDate) {
    setError("The start date must be before or equal to the end date.");
    return;
  }

  const tab = await findKhanTab();
  if (!tab?.id) {
    setError("Open the Khan Individual Student Report tab before using the Khan API capture.");
    return;
  }

  setStatus(`Requesting Khan activity data for ${startDate} through ${endDate}...`);

  try {
    let pageCapture = null;
    try {
      pageCapture = await readKhanTab(tab);
    } catch {
      pageCapture = null;
    }

    const apiResult = await requestKhanActivityForCurrentStudent(tab, startDate, endDate);
    lastCapture = buildApiCapture(tab, pageCapture, apiResult, startDate, endDate);

    await chrome.storage.local.set({ [STORAGE_KEY]: lastCapture });
    renderCapture(lastCapture);
    setStatus(`Captured from Khan API: ${lastCapture.studentSummary.studentName || apiResult.studentKaid}, ${formatMinutes(apiResult.exerciseMinutes)} exercises, ${formatMinutes(apiResult.timeOnTaskMinutes)} time on task.`);
  } catch (error) {
    setError(error.message || String(error));
  }
}

async function captureClassViaApi() {
  const startDate = elements.weekStart.value;
  const endDate = elements.weekEnd.value;
  if (!startDate || !endDate) {
    setError("Choose a start date and end date before using the Khan class API capture.");
    return;
  }
  if (startDate > endDate) {
    setError("The start date must be before or equal to the end date.");
    return;
  }

  const tab = await findKhanTab();
  if (!tab?.id) {
    setError("Open the Khan Individual Student Report tab before using the Khan class API capture.");
    return;
  }

  setStatus("Looking for students in the Khan Switch student control...");

  try {
    const rosterResult = await collectKhanRoster(tab);
    if (!rosterResult.students.length) {
      throw new Error("No students with Khan IDs were found. Open the Individual Student Report, click Switch student once, then try again.");
    }

    setStatus(`Found ${rosterResult.students.length} student(s). Requesting Khan minutes for ${startDate} through ${endDate}...`);
    const apiResult = await requestKhanActivitiesForRoster(tab, rosterResult.students, startDate, endDate);
    lastCapture = buildClassApiCapture(tab, rosterResult, apiResult, startDate, endDate);

    await chrome.storage.local.set({ [STORAGE_KEY]: lastCapture });
    renderCapture(lastCapture);

    const failedCount = lastCapture.studentSummaries.filter((student) => student.error).length;
    const status = `Captured ${lastCapture.studentSummaries.length} student(s) from Khan API`;
    setStatus(failedCount ? `${status}; ${failedCount} had errors. Copy Diagnostics for details.` : `${status}.`);
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
    .sort((a, b) => scoreReport(b) - scoreReport(a))[0];

  return {
    pageUrl: tab.url,
    pageTitle: tab.title,
    bestFrameUrl: bestReport.url,
    bestFrameTitle: bestReport.title,
    pageKind: bestReport.pageKind || "unknown",
    dateRange: bestReport.dateRange || "",
    studentSummary: bestReport.studentSummary || emptyStudentSummary(),
    rows: dedupeRows(frameReports.flatMap((report) => report.rows || [])),
    activityRows: dedupeActivityRows(frameReports.flatMap((report) => report.activityRows || [])),
    frameReports: frameReports.map((report) => ({
      frameIndex: report.frameIndex,
      url: report.url,
      title: report.title,
      rowCount: report.rows?.length || 0,
      activityRowCount: report.activityRows?.length || 0,
      studentSummary: report.studentSummary || emptyStudentSummary(),
      pageKind: report.pageKind || "unknown",
      dateRange: report.dateRange || "",
      diagnostics: report.diagnostics,
      textSample: report.textSample
    }))
  };
}

async function requestKhanActivityForCurrentStudent(tab, startDate, endDate) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: "MAIN",
    func: requestKhanActivityFromPage,
    args: [startDate, endDate]
  });

  const frameResults = results
    .map((item, index) => ({ frameIndex: index + 1, ...(item.result || {}) }))
    .filter((result) => result.url || result.reason || result.error);

  const success = frameResults.find((result) => result.ok && result.operationName === "KAClassroom_GetActivitySessions");
  if (success) {
    return {
      ...success,
      frameResults
    };
  }

  const usefulErrors = frameResults
    .filter((result) => result.reason || result.error || result.status)
    .map((result) => `Frame ${result.frameIndex}: ${result.reason || result.error || `HTTP ${result.status}`}`)
    .slice(0, 5)
    .join("; ");

  throw new Error(usefulErrors || "Khan API capture did not return activity data. Make sure the current Khan tab is an Individual Student Report page.");
}

async function collectKhanRoster(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: collectKhanStudentRosterFromPage
  });

  const frameResults = results
    .map((item, index) => ({ frameIndex: index + 1, ...(item.result || {}) }))
    .filter((result) => result.url || result.reason || result.students?.length);

  return {
    collectedAt: new Date().toISOString(),
    pageUrl: tab.url,
    pageTitle: tab.title,
    students: dedupeRosterStudents(frameResults.flatMap((frame) => frame.students || [])),
    frameResults
  };
}

async function requestKhanActivitiesForRoster(tab, students, startDate, endDate) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: requestKhanActivitiesForStudentsFromPage,
    args: [students, startDate, endDate]
  });

  const result = results.find((item) => item.result?.ok || item.result?.results || item.result?.error)?.result;
  if (!result) {
    throw new Error("Khan class API capture did not return a result from the current tab.");
  }
  if (!result.ok) {
    throw new Error(result.error || result.reason || "Khan class API capture failed.");
  }
  return result;
}

function buildApiCapture(tab, pageCapture, apiResult, startDate, endDate) {
  const studentName = pageCapture?.studentSummary?.studentName || apiResult.studentName || apiResult.studentKaid || "";
  const dateRange = `${startDate} - ${endDate}`;
  const activityRows = (apiResult.sessions || []).map((session) => ({
    dateText: formatActivityDate(session.eventTimestamp),
    activity: compactText([session.itemTitle, session.itemSubtitle].filter(Boolean).join(" - ")) || session.contentKind || "Activity",
    minutes: session.durationMinutes ?? "",
    sourceText: `Khan API session ${session.id || ""}`.trim()
  }));

  return {
    pageUrl: tab.url,
    pageTitle: tab.title,
    bestFrameUrl: apiResult.url || pageCapture?.bestFrameUrl || "",
    bestFrameTitle: pageCapture?.bestFrameTitle || "",
    pageKind: "individual-student-report-api",
    dateRange,
    expectedWeekStart: startDate,
    expectedWeekEnd: endDate,
    capturedAt: new Date().toISOString(),
    studentSummary: {
      studentName,
      exerciseMinutes: apiResult.exerciseMinutes,
      timeOnTaskMinutes: apiResult.timeOnTaskMinutes,
      detectedDateRange: dateRange,
      sourceText: "Khan GraphQL KAClassroom_GetActivitySessions"
    },
    rows: [],
    activityRows,
    frameReports: pageCapture?.frameReports || [],
    structuredApi: {
      operationName: apiResult.operationName,
      requestUrl: apiResult.requestUrl,
      studentKaid: apiResult.studentKaid,
      startDate: apiResult.startDate,
      endDate: apiResult.endDate,
      status: apiResult.status,
      exerciseMinutes: apiResult.exerciseMinutes,
      timeOnTaskMinutes: apiResult.timeOnTaskMinutes,
      sessionCount: activityRows.length,
      frameResults: apiResult.frameResults
    }
  };
}

function buildClassApiCapture(tab, rosterResult, apiResult, startDate, endDate) {
  const dateRange = `${startDate} - ${endDate}`;
  const studentSummaries = apiResult.results.map((result) => ({
    studentName: result.studentName || result.studentKaid,
    studentKaid: result.studentKaid,
    exerciseMinutes: result.exerciseMinutes,
    timeOnTaskMinutes: result.timeOnTaskMinutes,
    detectedDateRange: dateRange,
    sourceText: result.ok ? "Khan GraphQL KAClassroom_GetActivitySessions" : result.error || result.reason || "Khan API error",
    error: result.ok ? "" : result.error || result.reason || `HTTP ${result.status || "unknown"}`
  }));
  const successful = studentSummaries.filter((student) => !student.error);
  const totalExerciseMinutes = successful.reduce((total, student) => total + Number(student.exerciseMinutes || 0), 0);
  const totalTimeOnTaskMinutes = successful.reduce((total, student) => total + Number(student.timeOnTaskMinutes || 0), 0);
  const activityRows = apiResult.results.flatMap((result) => (result.sessions || []).map((session) => ({
    dateText: formatActivityDate(session.eventTimestamp),
    activity: compactText([result.studentName || result.studentKaid, session.itemTitle, session.itemSubtitle].filter(Boolean).join(" - ")) || session.contentKind || "Activity",
    minutes: session.durationMinutes ?? "",
    sourceText: `Khan API session ${session.id || ""}`.trim()
  })));

  return {
    pageUrl: tab.url,
    pageTitle: tab.title,
    bestFrameUrl: tab.url,
    bestFrameTitle: tab.title,
    pageKind: "class-api",
    dateRange,
    expectedWeekStart: startDate,
    expectedWeekEnd: endDate,
    capturedAt: new Date().toISOString(),
    studentSummary: {
      studentName: `${studentSummaries.length} students`,
      exerciseMinutes: totalExerciseMinutes,
      timeOnTaskMinutes: totalTimeOnTaskMinutes,
      detectedDateRange: dateRange,
      sourceText: "Khan GraphQL class capture"
    },
    studentSummaries,
    rows: studentSummaries.map((student) => ({
      name: student.studentName,
      minutes: student.timeOnTaskMinutes ?? "",
      sourceText: student.error || `Exercises ${student.exerciseMinutes ?? ""}; Time on task ${student.timeOnTaskMinutes ?? ""}`
    })),
    activityRows,
    frameReports: [],
    structuredApi: {
      operationName: "KAClassroom_GetActivitySessions",
      startDate,
      endDate,
      rosterCount: rosterResult.students.length,
      successCount: successful.length,
      errorCount: studentSummaries.length - successful.length,
      roster: rosterResult.students,
      rosterFrames: rosterResult.frameResults,
      results: apiResult.results
    }
  };
}

function renderCapture(capture) {
  const studentSummary = capture.studentSummary || emptyStudentSummary();
  elements.studentName.textContent = studentSummary.studentName || "Not detected";
  elements.exerciseMinutes.textContent = formatMinutes(studentSummary.exerciseMinutes);
  elements.timeOnTaskMinutes.textContent = formatMinutes(studentSummary.timeOnTaskMinutes);
  elements.dateRange.textContent = capture.dateRange || "Not detected";
  elements.bestFrame.textContent = capture.bestFrameUrl || "Not detected";

  elements.downloadButton.disabled = !hasStudentSummary(studentSummary) && capture.rows.length === 0 && (capture.activityRows?.length || 0) === 0;
  elements.copyDiagnosticsButton.disabled = false;

  renderStudentSummary(studentSummary, capture.studentSummaries || []);
  renderTable(capture.rows);
  renderActivityTable(capture.activityRows || []);
  elements.diagnostics.textContent = formatDiagnostics(capture);
}

function scoreReport(report) {
  let score = 0;
  if (hasStudentSummary(report.studentSummary)) score += 100;
  if (report.studentSummary?.studentName) score += 10;
  if (report.studentSummary?.exerciseMinutes !== null) score += 20;
  if (report.studentSummary?.timeOnTaskMinutes !== null) score += 20;
  score += report.activityRows?.length || 0;
  score += report.rows?.length || 0;
  return score;
}

function renderStudentSummary(summary, summaries = []) {
  const rows = summaries.length ? summaries : hasStudentSummary(summary) ? [summary] : [];
  elements.studentSummaryTable.className = rows.length ? "table" : "table empty";
  elements.studentSummaryTable.innerHTML = "";

  if (!rows.length) {
    elements.studentSummaryTable.textContent = "No Individual Student Report metrics captured.";
    return;
  }

  const header = document.createElement("div");
  header.className = "row student-report header";
  header.innerHTML = "<div>Student</div><div>Exercises</div><div>Time on task</div><div>Date range</div>";
  elements.studentSummaryTable.append(header);

  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "row student-report";
    line.innerHTML = `
      <div>${escapeHtml(row.studentName || "Not detected")}${row.error ? `<div class="source">${escapeHtml(row.error)}</div>` : ""}</div>
      <div>${escapeHtml(formatMinutes(row.exerciseMinutes))}</div>
      <div>${escapeHtml(formatMinutes(row.timeOnTaskMinutes))}</div>
      <div>${escapeHtml(row.detectedDateRange || "Not detected")}</div>
    `;
    elements.studentSummaryTable.append(line);
  }
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
    studentSummary: capture.studentSummary || emptyStudentSummary(),
    studentSummaries: capture.studentSummaries || [],
    structuredApi: capture.structuredApi || null,
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

async function copyNetworkProbe() {
  if (!lastNetworkProbe) return;
  await navigator.clipboard.writeText(JSON.stringify(lastNetworkProbe, null, 2));
  setStatus("Network probe copied.");
}

function downloadCsv() {
  if (!lastCapture) return;

  const activityRows = lastCapture.activityRows || [];
  const studentSummary = lastCapture.studentSummary || emptyStudentSummary();
  const studentSummaries = lastCapture.studentSummaries || [];
  const csv = studentSummaries.length
    ? [
      "Expected Week Start,Expected Week End,Khan Date Range,Student,Student KAID,Exercise Minutes,Time On Task Minutes,Error,Source",
      ...studentSummaries.map((row) => [
        lastCapture.expectedWeekStart,
        lastCapture.expectedWeekEnd,
        row.detectedDateRange || lastCapture.dateRange,
        row.studentName,
        row.studentKaid || "",
        row.exerciseMinutes ?? "",
        row.timeOnTaskMinutes ?? "",
        row.error || "",
        row.sourceText || ""
      ].map(csvCell).join(","))
    ].join("\n")
    : hasStudentSummary(studentSummary)
    ? [
      "Expected Week Start,Expected Week End,Khan Date Range,Student,Exercise Minutes,Time On Task Minutes,Source",
      [
        lastCapture.expectedWeekStart,
        lastCapture.expectedWeekEnd,
        studentSummary.detectedDateRange || lastCapture.dateRange,
        studentSummary.studentName,
        studentSummary.exerciseMinutes ?? "",
        studentSummary.timeOnTaskMinutes ?? "",
        studentSummary.sourceText || ""
      ].map(csvCell).join(",")
    ].join("\n")
    : activityRows.length
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

function hasStudentSummary(summary) {
  return Boolean(summary && (
    summary.studentName ||
    summary.exerciseMinutes !== null ||
    summary.timeOnTaskMinutes !== null
  ));
}

function emptyStudentSummary() {
  return {
    studentName: "",
    exerciseMinutes: null,
    timeOnTaskMinutes: null,
    detectedDateRange: "",
    sourceText: ""
  };
}

function formatMinutes(value) {
  return value === null || value === undefined || value === "" ? "Not detected" : `${value} min`;
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

function dedupeRosterStudents(students) {
  const byKaid = new Map();
  for (const student of students) {
    const kaid = String(student.kaid || "").trim();
    if (!kaid) continue;
    const current = byKaid.get(kaid);
    const next = {
      kaid,
      name: compactText(student.name || ""),
      source: student.source || ""
    };
    if (!current || (!current.name && next.name) || next.source === "current-page") {
      byKaid.set(kaid, next);
    }
  }
  return Array.from(byKaid.values()).sort((a, b) => (a.name || a.kaid).localeCompare(b.name || b.kaid));
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

function compactText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function formatActivityDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
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

function analyzeNetworkLog(log) {
  const haystack = [
    log.url,
    log.requestBodyPreview,
    log.responseBodyPreview,
    JSON.stringify(log.requestJsonShape || {}),
    JSON.stringify(log.responseJsonShape || {})
  ].join("\n");

  const dateHints = findDateHints(haystack);
  const metricHints = findMetricHints(haystack);
  const reportHints = findReportHints(haystack);
  const isCandidate = /graphql|api|report|activity|progress|student|learner/i.test(haystack) || dateHints.length > 0 || metricHints.length > 0;

  return {
    isCandidate,
    dateHints,
    metricHints,
    reportHints
  };
}

function findDateHints(text) {
  return uniqueStrings([
    ...String(text || "").matchAll(/\b(?:startDate|endDate|start_date|end_date|from|to|begin|until|dateRange|date_range|period)\b.{0,80}/gi)
  ].map((match) => match[0]).concat([
    ...String(text || "").matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)
  ].map((match) => match[0])).concat([
    ...String(text || "").matchAll(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g)
  ].map((match) => match[0]))).slice(0, 40);
}

function findMetricHints(text) {
  return uniqueStrings([...String(text || "").matchAll(/\b(?:exercise|time.?on.?task|minute|duration|active|activity|skill|course|score)\b.{0,80}/gi)]
    .map((match) => match[0]))
    .slice(0, 40);
}

function findReportHints(text) {
  return uniqueStrings([...String(text || "").matchAll(/\b(?:IndividualStudent|individual.?student|activity.?log|student.?report|teacher|class|kaid|learner)\b.{0,80}/gi)]
    .map((match) => match[0]))
    .slice(0, 40);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.map((item) => String(item || "").trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function installKhanNetworkProbeInPage() {
  if (!/khanacademy\.org/i.test(location.hostname)) {
    return { ok: false, reason: "not a Khan frame", url: location.href };
  }

  if (window.__KHAN_GRADER_NETWORK_PROBE__?.installed) {
    window.__KHAN_GRADER_NETWORK_PROBE__.logs = [];
    return { ok: true, reinstalled: false, url: location.href };
  }

  const probe = {
    installed: true,
    logs: [],
    maxLogs: 80,
    originalFetch: window.fetch,
    originalXhrOpen: XMLHttpRequest.prototype.open,
    originalXhrSend: XMLHttpRequest.prototype.send
  };

  window.__KHAN_GRADER_NETWORK_PROBE__ = probe;

  window.fetch = async function khanGraderFetchProbe(input, init = {}) {
    const request = await normalizeFetchRequest(input, init);
    const record = startProbeRecord("fetch", request.url, request.method, request.body, request);

    try {
      const response = await probe.originalFetch.apply(this, arguments);
      record.status = response.status;
      record.contentType = response.headers.get("content-type") || "";
      captureResponsePreview(record, response);
      return response;
    } catch (error) {
      record.error = error?.message || String(error);
      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function khanGraderXhrOpenProbe(method, url) {
    this.__khanGraderProbe = {
      method: method || "GET",
      url: absoluteUrl(url)
    };
    return probe.originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function khanGraderXhrSendProbe(body) {
    const info = this.__khanGraderProbe || {};
    const record = startProbeRecord("xhr", info.url || "", info.method || "GET", body, {});

    this.addEventListener("loadend", () => {
      record.status = this.status;
      record.contentType = this.getResponseHeader("content-type") || "";
      if (/json|graphql|text/i.test(record.contentType || "")) {
        record.responseBodyPreview = truncateText(this.responseText || "", 12000);
        record.responseJsonShape = parseJsonShape(record.responseBodyPreview);
      }
      record.completedAt = new Date().toISOString();
    });

    return probe.originalXhrSend.apply(this, arguments);
  };

  return { ok: true, reinstalled: true, url: location.href };

  function startProbeRecord(type, url, method, body, requestInfo = {}) {
    const requestBodyPreview = serializeBody(body);
    const record = {
      type,
      startedAt: new Date().toISOString(),
      url: absoluteUrl(url),
      method: method || "GET",
      requestHeaders: requestInfo.headers || {},
      requestBodyReadError: requestInfo.bodyReadError || "",
      requestBodyPreview,
      requestJsonShape: parseJsonShape(requestBodyPreview),
      status: null,
      contentType: "",
      responseBodyPreview: "",
      responseJsonShape: null,
      completedAt: ""
    };

    if (/khanacademy\.org/i.test(record.url)) {
      probe.logs.push(record);
      if (probe.logs.length > probe.maxLogs) probe.logs.shift();
    }

    return record;
  }

  async function normalizeFetchRequest(input, init) {
    if (input instanceof Request) {
      const method = init.method || input.method || "GET";
      const headers = mergeHeaders(input.headers, init.headers);
      let body = init.body || null;
      let bodyReadError = "";

      if (body === null && !["GET", "HEAD"].includes(String(method).toUpperCase())) {
        try {
          body = await input.clone().text();
        } catch (error) {
          bodyReadError = error?.message || String(error);
        }
      }

      return {
        url: input.url,
        method,
        headers,
        body,
        bodyReadError
      };
    }
    return {
      url: String(input || ""),
      method: init.method || "GET",
      headers: mergeHeaders(null, init.headers),
      body: init.body || null,
      bodyReadError: ""
    };
  }

  function mergeHeaders(baseHeaders, overrideHeaders) {
    const headers = {};
    for (const [key, value] of new Headers(baseHeaders || {}).entries()) {
      headers[key] = value;
    }
    for (const [key, value] of new Headers(overrideHeaders || {}).entries()) {
      headers[key] = value;
    }
    return headers;
  }

  function captureResponsePreview(record, response) {
    const contentType = record.contentType || "";
    if (!/json|graphql|text/i.test(contentType)) return;

    response.clone().text()
      .then((text) => {
        record.responseBodyPreview = truncateText(text, 12000);
        record.responseJsonShape = parseJsonShape(record.responseBodyPreview);
        record.completedAt = new Date().toISOString();
      })
      .catch((error) => {
        record.responseReadError = error?.message || String(error);
      });
  }

  function absoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url || "");
    }
  }

  function serializeBody(body) {
    if (body === null || body === undefined) return "";
    if (typeof body === "string") return truncateText(body, 12000);
    if (body instanceof URLSearchParams) return truncateText(body.toString(), 12000);
    if (body instanceof FormData) {
      return truncateText(JSON.stringify(Array.from(body.entries())), 12000);
    }
    if (body instanceof Blob) return `[Blob ${body.type || "unknown"} ${body.size} bytes]`;
    if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength} bytes]`;
    try {
      return truncateText(JSON.stringify(body), 12000);
    } catch {
      return truncateText(String(body), 12000);
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
    return { paths: paths.slice(0, 120), sample };

    function walk(current, currentPath, depth) {
      if (depth > 7 || paths.length > 180) return;
      if (Array.isArray(current)) {
        paths.push(`${currentPath}[] length=${current.length}`);
        current.slice(0, 8).forEach((item, index) => walk(item, `${currentPath}[${index}]`, depth + 1));
        return;
      }
      if (!current || typeof current !== "object") return;

      for (const [key, child] of Object.entries(current)) {
        const childPath = `${currentPath}.${key}`;
        if (/date|time|minute|duration|exercise|activity|student|learner|kaid|course|skill|score|total|report/i.test(key)) {
          paths.push(childPath);
          if (Object.keys(sample).length < 30) sample[childPath] = summarizeValue(child);
        }
        walk(child, childPath, depth + 1);
      }
    }
  }

  function summarizeValue(value) {
    if (Array.isArray(value)) return `[array length ${value.length}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).slice(0, 10).join(", ")}}`;
    return value;
  }

  function truncateText(text, maxLength) {
    const value = String(text || "");
    return value.length > maxLength ? `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]` : value;
  }
}

function collectKhanNetworkProbeFromPage() {
  const probe = window.__KHAN_GRADER_NETWORK_PROBE__;
  return {
    url: location.href,
    installed: Boolean(probe?.installed),
    logs: probe?.logs || []
  };
}

async function requestKhanActivityFromPage(startDate, endDate) {
  if (!/khanacademy\.org/i.test(location.hostname)) {
    return { ok: false, reason: "not a Khan frame", url: location.href };
  }

  const studentKaid = getStudentKaidFromUrl(location.href);
  if (!studentKaid) {
    return {
      ok: false,
      reason: "student kaid not found in this frame URL",
      url: location.href
    };
  }

  const operationName = "KAClassroom_GetActivitySessions";
  const query = `query KAClassroom_GetActivitySessions($studentKaid: String!, $startDate: Date, $endDate: Date, $activityKind: String, $after: ID, $pageSize: Int) {
  user(kaid: $studentKaid) {
    id
    activityLogV2(
      startDate: $startDate
      endDate: $endDate
      activityKind: $activityKind
    ) {
      time {
        __typename
        exerciseMinutes
        totalMinutes
      }
      activitySessions(pageSize: $pageSize, after: $after) {
        sessions {
          id
          itemTitle: title
          itemSubtitle: subtitle
          activityKind {
            contentKind: id
            __typename
          }
          durationMinutes
          eventTimestamp
          ... on MasteryActivitySession {
            correctCount
            problemCount
            skillLevels {
              id
              after
              __typename
            }
            __typename
          }
          __typename
        }
        pageInfo {
          nextCursor
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

  const requestUrl = new URL("https://classroom.khanacademy.org/api/internal/graphql/KAClassroom_GetActivitySessions");
  requestUrl.searchParams.set("lang", "en");
  requestUrl.searchParams.set("app", "classroom-teacher");
  requestUrl.searchParams.set("_", String(Date.now()));

  const body = JSON.stringify({
    operationName,
    query,
    variables: {
      studentKaid,
      startDate,
      endDate,
      activityKind: null,
      after: null,
      pageSize: 50
    }
  });

  try {
    const response = await fetch(requestUrl.href, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-ka-fkey": "1"
      },
      body
    });
    const responseText = await response.text();
    const json = safeJsonParse(responseText);
    const activityLog = json?.data?.user?.activityLogV2;
    const sessions = activityLog?.activitySessions?.sessions || [];

    if (!response.ok || !activityLog) {
      return {
        ok: false,
        reason: json?.errors?.[0]?.message || "activityLogV2 missing from Khan response",
        url: location.href,
        requestUrl: requestUrl.href,
        status: response.status,
        responsePreview: truncateText(responseText, 3000)
      };
    }

    return {
      ok: true,
      operationName,
      url: location.href,
      requestUrl: requestUrl.href,
      status: response.status,
      studentKaid,
      startDate,
      endDate,
      exerciseMinutes: activityLog.time?.exerciseMinutes ?? null,
      timeOnTaskMinutes: activityLog.time?.totalMinutes ?? null,
      nextCursor: activityLog.activitySessions?.pageInfo?.nextCursor || null,
      sessions: sessions.map((session) => ({
        id: session.id || "",
        itemTitle: session.itemTitle || "",
        itemSubtitle: session.itemSubtitle || "",
        contentKind: session.activityKind?.contentKind || "",
        durationMinutes: session.durationMinutes ?? null,
        eventTimestamp: session.eventTimestamp || "",
        correctCount: session.correctCount ?? null,
        problemCount: session.problemCount ?? null
      }))
    };
  } catch (error) {
    return {
      ok: false,
      reason: "Khan API request failed",
      error: error?.message || String(error),
      url: location.href,
      requestUrl: requestUrl.href,
      studentKaid,
      startDate,
      endDate
    };
  }

  function getStudentKaidFromUrl(url) {
    const match = String(url || "").match(/individual-student\/(kaid_[A-Za-z0-9]+)/i);
    return match ? match[1] : "";
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function truncateText(text, maxLength) {
    const value = String(text || "");
    return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]` : value;
  }
}

async function collectKhanStudentRosterFromPage() {
  if (!/khanacademy\.org/i.test(location.hostname)) {
    return { ok: false, reason: "not a Khan frame", url: location.href, students: [] };
  }

  const before = collectStudents();
  const switchControl = findSwitchStudentControl();
  if (switchControl) {
    try {
      switchControl.click();
      await delay(900);
    } catch {
      // The initial DOM scan may still have enough roster data.
    }
  }

  const after = collectStudents();
  try {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  } catch {
    // Closing the menu is best effort only.
  }

  return {
    ok: true,
    url: location.href,
    title: document.title,
    openedSwitchStudent: Boolean(switchControl),
    students: dedupe([...before, ...after])
  };

  function collectStudents() {
    const students = [];
    const currentKaid = getStudentKaidFromUrl(location.href);
    if (currentKaid) {
      students.push({
        kaid: currentKaid,
        name: inferCurrentStudentName(),
        source: "current-page"
      });
    }

    const elements = Array.from(document.querySelectorAll([
      "a[href*='individual-student/kaid_']",
      "a[href*='kaid_']",
      "button",
      "[role='button']",
      "[role='option']",
      "[role='menuitem']",
      "[aria-label]",
      "[title]",
      "option"
    ].join(",")));

    for (const element of elements) {
      const sourceText = [
        element.getAttribute("href"),
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("value"),
        element.textContent,
        ...Object.values(element.dataset || {})
      ].filter(Boolean).join(" ");

      for (const kaid of findKaids(sourceText)) {
        students.push({
          kaid,
          name: cleanStudentName(element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || ""),
          source: element.tagName.toLowerCase()
        });
      }
    }

    const html = document.documentElement?.innerHTML || "";
    for (const kaid of findKaids(html).slice(0, 200)) {
      students.push({ kaid, name: "", source: "html" });
    }

    return students;
  }

  function findSwitchStudentControl() {
    return Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(isVisible)
      .find((element) => /switch\s*student/i.test(compactText([
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title")
      ].filter(Boolean).join(" "))));
  }

  function inferCurrentStudentName() {
    const heading = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
      .filter(isVisible)
      .map((element) => cleanStudentName(element.textContent || ""))
      .find(looksLikeStudentName);
    if (heading) return heading;

    const selected = Array.from(document.querySelectorAll("[aria-selected='true'], option:checked"))
      .map((element) => cleanStudentName(element.textContent || element.getAttribute("label") || ""))
      .find(looksLikeStudentName);
    return selected || "";
  }

  function findKaids(text) {
    const matches = String(text || "").match(/kaid_[A-Za-z0-9]+/g) || [];
    return Array.from(new Set(matches));
  }

  function dedupe(students) {
    const byKaid = new Map();
    for (const student of students) {
      const kaid = String(student.kaid || "").trim();
      if (!kaid) continue;
      const next = {
        kaid,
        name: cleanStudentName(student.name || ""),
        source: student.source || ""
      };
      const current = byKaid.get(kaid);
      if (!current || (!current.name && next.name) || next.source === "current-page") {
        byKaid.set(kaid, next);
      }
    }
    return Array.from(byKaid.values());
  }

  function cleanStudentName(value) {
    return compactText(value)
      .replace(/\b(switch student|student|learner|selected)\b/gi, " ")
      .replace(/kaid_[A-Za-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikeStudentName(value) {
    const text = cleanStudentName(value);
    if (text.length < 3 || text.length > 80) return false;
    if (!/[a-z]/i.test(text)) return false;
    if (/\d/.test(text)) return false;
    return !/\b(report|activity|date|filter|exercise|time on task|dashboard|class|teacher|settings|assignments|skills|overview|search|subjects|minutes|log)\b/i.test(text);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function compactText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ").trim();
  }

  function getStudentKaidFromUrl(url) {
    const match = String(url || "").match(/individual-student\/(kaid_[A-Za-z0-9]+)/i);
    return match ? match[1] : "";
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

async function requestKhanActivitiesForStudentsFromPage(students, startDate, endDate) {
  if (!/khanacademy\.org/i.test(location.hostname)) {
    return { ok: false, reason: "not a Khan frame", url: location.href, results: [] };
  }

  const operationName = "KAClassroom_GetActivitySessions";
  const query = `query KAClassroom_GetActivitySessions($studentKaid: String!, $startDate: Date, $endDate: Date, $activityKind: String, $after: ID, $pageSize: Int) {
  user(kaid: $studentKaid) {
    id
    activityLogV2(
      startDate: $startDate
      endDate: $endDate
      activityKind: $activityKind
    ) {
      time {
        __typename
        exerciseMinutes
        totalMinutes
      }
      activitySessions(pageSize: $pageSize, after: $after) {
        sessions {
          id
          itemTitle: title
          itemSubtitle: subtitle
          activityKind {
            contentKind: id
            __typename
          }
          durationMinutes
          eventTimestamp
          ... on MasteryActivitySession {
            correctCount
            problemCount
            skillLevels {
              id
              after
              __typename
            }
            __typename
          }
          __typename
        }
        pageInfo {
          nextCursor
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

  const results = [];
  for (const student of students) {
    results.push(await requestStudent(student));
    await delay(125);
  }

  return {
    ok: true,
    url: location.href,
    operationName,
    startDate,
    endDate,
    results
  };

  async function requestStudent(student) {
    const studentKaid = student.kaid;
    const requestUrl = new URL("https://classroom.khanacademy.org/api/internal/graphql/KAClassroom_GetActivitySessions");
    requestUrl.searchParams.set("lang", "en");
    requestUrl.searchParams.set("app", "classroom-teacher");
    requestUrl.searchParams.set("_", String(Date.now()));

    const body = JSON.stringify({
      operationName,
      query,
      variables: {
        studentKaid,
        startDate,
        endDate,
        activityKind: null,
        after: null,
        pageSize: 50
      }
    });

    try {
      const response = await fetch(requestUrl.href, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-ka-fkey": "1"
        },
        body
      });
      const responseText = await response.text();
      const json = safeJsonParse(responseText);
      const activityLog = json?.data?.user?.activityLogV2;
      const sessions = activityLog?.activitySessions?.sessions || [];

      if (!response.ok || !activityLog) {
        return {
          ok: false,
          studentKaid,
          studentName: student.name || "",
          status: response.status,
          requestUrl: requestUrl.href,
          reason: json?.errors?.[0]?.message || "activityLogV2 missing from Khan response",
          responsePreview: truncateText(responseText, 1200)
        };
      }

      return {
        ok: true,
        studentKaid,
        studentName: student.name || "",
        status: response.status,
        requestUrl: requestUrl.href,
        exerciseMinutes: activityLog.time?.exerciseMinutes ?? null,
        timeOnTaskMinutes: activityLog.time?.totalMinutes ?? null,
        nextCursor: activityLog.activitySessions?.pageInfo?.nextCursor || null,
        sessions: sessions.map((session) => ({
          id: session.id || "",
          itemTitle: session.itemTitle || "",
          itemSubtitle: session.itemSubtitle || "",
          contentKind: session.activityKind?.contentKind || "",
          durationMinutes: session.durationMinutes ?? null,
          eventTimestamp: session.eventTimestamp || "",
          correctCount: session.correctCount ?? null,
          problemCount: session.problemCount ?? null
        }))
      };
    } catch (error) {
      return {
        ok: false,
        studentKaid,
        studentName: student.name || "",
        requestUrl: requestUrl.href,
        error: error?.message || String(error)
      };
    }
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function truncateText(text, maxLength) {
    const value = String(text || "");
    return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]` : value;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
