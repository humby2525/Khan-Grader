const BUILD_VERSION = "0.8.1";
const STORAGE_KEY = "khanGrader.lastCapture";
const CLASS_CONFIG_STORAGE_KEY = "khanGrader.classConfigs";

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
  elements.captureAllClassesButton.addEventListener("click", captureAllClassesViaApi);
  elements.captureButton.addEventListener("click", captureCurrentTab);
  elements.startNetworkProbeButton.addEventListener("click", startNetworkProbe);
  elements.collectNetworkProbeButton.addEventListener("click", collectNetworkProbe);
  elements.openKhanButton.addEventListener("click", () => chrome.tabs.create({ url: "https://classroom.khanacademy.org/" }));
  elements.saveClassesButton.addEventListener("click", saveClassConfigs);
  elements.downloadButton.addEventListener("click", downloadCsv);
  elements.copyDiagnosticsButton.addEventListener("click", copyDiagnostics);
  elements.copyNetworkProbeButton.addEventListener("click", copyNetworkProbe);

  setDefaultWeek();

  const stored = await chrome.storage.local.get([STORAGE_KEY, CLASS_CONFIG_STORAGE_KEY]);
  loadClassConfigs(stored[CLASS_CONFIG_STORAGE_KEY] || []);
  if (stored[STORAGE_KEY]) {
    lastCapture = stored[STORAGE_KEY];
    renderCapture(lastCapture);
    setStatus("Loaded previous capture.");
  }
}

function loadClassConfigs(configs) {
  for (let index = 0; index < 3; index += 1) {
    const config = configs[index] || {};
    elements[`className${index + 1}`].value = config.name || "";
    elements[`classUrl${index + 1}`].value = config.url || "";
  }
}

function readClassConfigs() {
  const configs = [];
  for (let index = 1; index <= 3; index += 1) {
    const name = compactText(elements[`className${index}`].value);
    const url = compactText(elements[`classUrl${index}`].value);
    if (!name && !url) continue;
    configs.push({
      name: name || `Class ${index}`,
      url
    });
  }
  return configs;
}

async function saveClassConfigs() {
  const configs = readClassConfigs();
  const invalid = configs.find((config) => !isValidKhanUrl(config.url));
  if (invalid) {
    setError(`Check the roster URL for ${invalid.name}. It should be a khanacademy.org URL.`);
    return;
  }

  await chrome.storage.local.set({ [CLASS_CONFIG_STORAGE_KEY]: configs });
  setStatus(`Saved ${configs.length} class roster URL(s).`);
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
    setError("Open the Khan class Roster page or an Individual Student Report tab before using the Khan class API capture.");
    return;
  }

  setStatus("Looking for students on the Khan roster page or in the Switch student control...");

  try {
    const rosterResult = await collectKhanRoster(tab);
    if (rosterResult.students.length <= 1) {
      renderRosterDiagnostics(rosterResult);
      setStatus("Student IDs were not exposed directly. Trying Switch-student navigation capture...");
      const switchResult = await captureKhanClassBySwitching(tab, startDate, endDate);
      if (!switchResult.results.filter((result) => result.ok).length || switchResult.results.length <= 1) {
        lastNetworkProbe = {
          build: BUILD_VERSION,
          type: "khan-switch-student-capture",
          collectedAt: new Date().toISOString(),
          rosterDiscovery: rosterResult,
          switchCapture: switchResult
        };
        elements.networkProbe.textContent = JSON.stringify(lastNetworkProbe, null, 2);
        elements.copyNetworkProbeButton.disabled = false;
        throw new Error("The Switch-student navigation fallback still did not find the class roster. Copy Network Probe and paste it here.");
      }

      const switchRoster = {
        ...rosterResult,
        students: switchResult.results.map((result) => ({
          kaid: result.studentKaid,
          name: result.studentName || result.studentKaid,
          source: "switch-student-navigation"
        })),
        switchCapture: switchResult
      };
      lastCapture = buildClassApiCapture(tab, switchRoster, switchResult, startDate, endDate);

      await chrome.storage.local.set({ [STORAGE_KEY]: lastCapture });
      renderCapture(lastCapture);

      const failedCount = lastCapture.studentSummaries.filter((student) => student.error).length;
      const status = `Captured ${lastCapture.studentSummaries.length} student(s) by switching Khan students`;
      setStatus(failedCount ? `${status}; ${failedCount} had errors. Copy Diagnostics for details.` : `${status}.`);
      return;
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

async function captureAllClassesViaApi() {
  const startDate = elements.weekStart.value;
  const endDate = elements.weekEnd.value;
  if (!startDate || !endDate) {
    setError("Choose a start date and end date before capturing all Khan classes.");
    return;
  }
  if (startDate > endDate) {
    setError("The start date must be before or equal to the end date.");
    return;
  }

  const configs = readClassConfigs();
  if (!configs.length) {
    setError("Add and save at least one Khan roster URL before capturing all classes.");
    return;
  }

  const invalid = configs.find((config) => !isValidKhanUrl(config.url));
  if (invalid) {
    setError(`Check the roster URL for ${invalid.name}. It should be a khanacademy.org URL.`);
    return;
  }

  await chrome.storage.local.set({ [CLASS_CONFIG_STORAGE_KEY]: configs });
  const previousDisabled = setCaptureButtonsDisabled(true);
  const classCaptures = [];
  const diagnostics = [];

  try {
    for (let index = 0; index < configs.length; index += 1) {
      const config = configs[index];
      setStatus(`Loading ${config.name} roster (${index + 1} of ${configs.length})...`);
      const classCapture = await captureConfiguredClass(config, startDate, endDate);
      classCaptures.push(classCapture.capture);
      diagnostics.push(classCapture.diagnostics);
      const studentCount = classCapture.capture.studentSummaries?.length || 0;
      setStatus(`Captured ${config.name}: ${studentCount} student(s).`);
    }

    lastCapture = buildAllClassesCapture(classCaptures, diagnostics, startDate, endDate);
    await chrome.storage.local.set({ [STORAGE_KEY]: lastCapture });
    renderCapture(lastCapture);
    setStatus(`Captured ${lastCapture.studentSummaries.length} student rows across ${classCaptures.length} class(es).`);
  } catch (error) {
    lastNetworkProbe = {
      build: BUILD_VERSION,
      type: "khan-all-classes-capture",
      collectedAt: new Date().toISOString(),
      startDate,
      endDate,
      diagnostics,
      failedClass: error.classConfig || null,
      failedRoster: error.rosterResult || null,
      error: error.message || String(error)
    };
    elements.networkProbe.textContent = JSON.stringify(lastNetworkProbe, null, 2);
    elements.copyNetworkProbeButton.disabled = false;
    setError(error.message || String(error));
  } finally {
    restoreCaptureButtonsDisabled(previousDisabled);
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
    world: "MAIN",
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

async function captureKhanClassBySwitching(tab, startDate, endDate) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: captureKhanClassBySwitchingStudentsFromPage,
    args: [startDate, endDate]
  });

  const result = results.find((item) => item.result?.ok || item.result?.results || item.result?.error)?.result;
  if (!result) {
    throw new Error("Khan Switch-student capture did not return a result from the current tab.");
  }
  if (!result.ok) {
    throw new Error(result.error || result.reason || "Khan Switch-student capture failed.");
  }
  return result;
}

async function captureConfiguredClass(config, startDate, endDate) {
  let tab = null;
  let rosterResult = null;
  try {
    tab = await chrome.tabs.create({ url: config.url, active: false });
    await waitForTabReady(tab.id, 20000);
    rosterResult = await waitForRosterStudents(tab.id, config.name, 12000);
    if (rosterResult.students.length <= 1) {
      await chrome.tabs.reload(tab.id);
      await waitForTabReady(tab.id, 20000);
      rosterResult = await waitForRosterStudents(tab.id, config.name, 12000);
    }
    if (rosterResult.students.length <= 1) {
      const error = new Error(`${config.name}: only found ${rosterResult.students.length} student(s) on the roster page after waiting. Open that roster page once in Chrome, confirm students are visible, then try Capture All Classes again.`);
      error.classConfig = config;
      error.rosterResult = rosterResult;
      throw error;
    }

    const loadedTab = await chrome.tabs.get(tab.id);
    const apiResult = await requestKhanActivitiesForRoster(loadedTab, rosterResult.students, startDate, endDate);
    const capture = buildClassApiCapture(loadedTab, {
      ...rosterResult,
      className: config.name
    }, apiResult, startDate, endDate);

    capture.className = config.name;
    capture.studentSummaries = (capture.studentSummaries || []).map((student) => ({
      ...student,
      className: config.name
    }));
    capture.rows = (capture.rows || []).map((row) => ({
      ...row,
      className: config.name
    }));
    capture.structuredApi = {
      ...capture.structuredApi,
      className: config.name,
      rosterUrl: config.url
    };

    return {
      capture,
      diagnostics: {
        className: config.name,
        rosterUrl: config.url,
        rosterCount: rosterResult.students.length,
        successCount: capture.structuredApi.successCount,
        errorCount: capture.structuredApi.errorCount
      }
    };
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // Closing a temporary tab is best effort only.
      }
    }
  }
}

async function waitForRosterStudents(tabId, className, timeoutMs) {
  const startedAt = Date.now();
  let bestRoster = {
    students: [],
    frameReports: [],
    pageUrl: "",
    pageTitle: ""
  };

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    const rosterResult = await collectKhanRoster(tab);
    if (rosterResult.students.length > bestRoster.students.length) {
      bestRoster = rosterResult;
      setStatus(`Loading ${className} roster: found ${bestRoster.students.length} student(s)...`);
    }
    if (rosterResult.students.length > 1) return rosterResult;
    await delay(750);
  }

  return bestRoster;
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
    className: rosterResult.className || "",
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
    className: rosterResult.className || "",
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
    className: rosterResult.className || "",
    studentSummary: {
      studentName: `${studentSummaries.length} students`,
      exerciseMinutes: totalExerciseMinutes,
      timeOnTaskMinutes: totalTimeOnTaskMinutes,
      detectedDateRange: dateRange,
      sourceText: "Khan GraphQL class capture"
    },
    studentSummaries,
    rows: studentSummaries.map((student) => ({
      className: student.className,
      name: student.studentName,
      minutes: student.timeOnTaskMinutes ?? "",
      sourceText: student.error || `Exercises ${student.exerciseMinutes ?? ""}; Time on task ${student.timeOnTaskMinutes ?? ""}`
    })),
    activityRows,
    frameReports: [],
    structuredApi: {
      operationName: "KAClassroom_GetActivitySessions",
      className: rosterResult.className || "",
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

function buildAllClassesCapture(classCaptures, diagnostics, startDate, endDate) {
  const dateRange = `${startDate} - ${endDate}`;
  const studentSummaries = classCaptures.flatMap((capture) => capture.studentSummaries || []);
  const successful = studentSummaries.filter((student) => !student.error);
  const totalExerciseMinutes = successful.reduce((total, student) => total + Number(student.exerciseMinutes || 0), 0);
  const totalTimeOnTaskMinutes = successful.reduce((total, student) => total + Number(student.timeOnTaskMinutes || 0), 0);
  const activityRows = classCaptures.flatMap((capture) => capture.activityRows || []);
  const rows = classCaptures.flatMap((capture) => capture.rows || []);

  return {
    pageUrl: classCaptures.map((capture) => capture.pageUrl).filter(Boolean).join(" | "),
    pageTitle: "Khan All Classes",
    bestFrameUrl: `${classCaptures.length} roster page(s)`,
    bestFrameTitle: "Khan All Classes",
    pageKind: "all-classes-api",
    dateRange,
    expectedWeekStart: startDate,
    expectedWeekEnd: endDate,
    capturedAt: new Date().toISOString(),
    studentSummary: {
      studentName: `${studentSummaries.length} students / ${classCaptures.length} classes`,
      exerciseMinutes: totalExerciseMinutes,
      timeOnTaskMinutes: totalTimeOnTaskMinutes,
      detectedDateRange: dateRange,
      sourceText: "Khan GraphQL all-classes capture"
    },
    studentSummaries,
    rows,
    activityRows,
    frameReports: [],
    structuredApi: {
      operationName: "KAClassroom_GetActivitySessions",
      startDate,
      endDate,
      classCount: classCaptures.length,
      studentRowCount: studentSummaries.length,
      successCount: successful.length,
      errorCount: studentSummaries.length - successful.length,
      classes: diagnostics,
      captures: classCaptures.map((capture) => capture.structuredApi)
    }
  };
}

function renderRosterDiagnostics(rosterResult) {
  lastNetworkProbe = {
    build: BUILD_VERSION,
    type: "khan-roster-discovery",
    collectedAt: new Date().toISOString(),
    ...rosterResult
  };
  elements.networkProbe.textContent = JSON.stringify(lastNetworkProbe, null, 2);
  elements.copyNetworkProbeButton.disabled = false;
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
  const includeClass = rows.some((row) => row.className);
  elements.studentSummaryTable.className = rows.length ? "table" : "table empty";
  elements.studentSummaryTable.innerHTML = "";

  if (!rows.length) {
    elements.studentSummaryTable.textContent = "No Individual Student Report metrics captured.";
    return;
  }

  const header = document.createElement("div");
  header.className = includeClass ? "row student-report with-class header" : "row student-report header";
  header.innerHTML = includeClass
    ? "<div>Class</div><div>Student</div><div>Exercises</div><div>Time on task</div><div>Date range</div>"
    : "<div>Student</div><div>Exercises</div><div>Time on task</div><div>Date range</div>";
  elements.studentSummaryTable.append(header);

  for (const row of rows) {
    const line = document.createElement("div");
    line.className = includeClass ? "row student-report with-class" : "row student-report";
    line.innerHTML = includeClass ? `
      <div>${escapeHtml(row.className || "")}</div>
      <div>${escapeHtml(row.studentName || "Not detected")}${row.error ? `<div class="source">${escapeHtml(row.error)}</div>` : ""}</div>
      <div>${escapeHtml(formatMinutes(row.exerciseMinutes))}</div>
      <div>${escapeHtml(formatMinutes(row.timeOnTaskMinutes))}</div>
      <div>${escapeHtml(row.detectedDateRange || "Not detected")}</div>
    ` : `
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
      "Expected Week Start,Expected Week End,Khan Date Range,Class,Student,Student KAID,Exercise Minutes,Time On Task Minutes,Error,Source",
      ...studentSummaries.map((row) => [
        lastCapture.expectedWeekStart,
        lastCapture.expectedWeekEnd,
        row.detectedDateRange || lastCapture.dateRange,
        row.className || "",
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

function isValidKhanUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)khanacademy\.org$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function waitForTabReady(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for Khan roster page to load."));
    }, timeoutMs);

    function finish() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab?.status === "complete") finish();
    });
  });
}

function setCaptureButtonsDisabled(disabled) {
  const buttons = [
    elements.captureApiButton,
    elements.captureClassApiButton,
    elements.captureAllClassesButton,
    elements.captureButton,
    elements.saveClassesButton
  ].filter(Boolean);
  const previous = buttons.map((button) => ({ button, disabled: button.disabled }));
  for (const button of buttons) button.disabled = disabled;
  return previous;
}

function restoreCaptureButtonsDisabled(previous) {
  for (const item of previous || []) {
    item.button.disabled = item.disabled;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

  const before = collectStudents(false);
  const switchControl = findSwitchStudentControl();
  const switchControlText = switchControl ? describeElement(switchControl) : "";
  if (switchControl) {
    try {
      clickElement(switchControl);
      await waitForRosterMenu(3500);
    } catch {
      // The initial DOM scan may still have enough roster data.
    }
  }

  const after = collectStudents(true);
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
    switchControlText,
    beforeCount: before.length,
    afterCount: after.length,
    visibleMenuTextSample: collectMenuTextSample(),
    students: dedupe([...before, ...after])
  };

  function collectStudents(includeMenu) {
    const students = [];
    const currentKaid = getStudentKaidFromUrl(location.href);
    if (currentKaid) {
      students.push({
        kaid: currentKaid,
        name: inferCurrentStudentName(),
        source: "current-page"
      });
    }

    const elements = includeMenu ? getRosterCandidateElements() : getCurrentReportLinkElements();

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
        const href = element.getAttribute("href") || "";
        const isReportLink = /individual-student\/kaid_/i.test(href);
        const isMenuItem = includeMenu && isLikelyRosterMenuItem(element);
        if (!isReportLink && !isMenuItem) continue;

        students.push({
          kaid,
          name: cleanStudentName(element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || ""),
          source: isReportLink ? "student-report-link" : "switch-student-menu"
        });
      }
    }

    return students;
  }

  function getCurrentReportLinkElements() {
    return Array.from(document.querySelectorAll("a[href*='individual-student/kaid_']")).filter(isVisible);
  }

  function getRosterCandidateElements() {
    return Array.from(document.querySelectorAll([
      "a[href*='individual-student/kaid_']",
      "[role='option']",
      "[role='menuitem']",
      "[role='menuitemradio']",
      "[role='listbox'] *",
      "[role='menu'] *",
      "[role='dialog'] *",
      "[aria-label*='student' i]",
      "[title*='student' i]",
      "option"
    ].join(","))).filter(isVisible);
  }

  function isLikelyRosterMenuItem(element) {
    const text = compactText([
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].filter(Boolean).join(" "));
    if (!findKaids(text).length && !findKaids(Object.values(element.dataset || {}).join(" ")).length) return false;
    if (text.length > 180) return false;
    if (/\b(cooldown|teacher|dashboard|settings|reports?|activity log|date range|exercise|time on task|my classes|assignments|skills|subjects|feedback|search)\b/i.test(text)) return false;
    return true;
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

  async function waitForRosterMenu(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (collectStudents(true).length > collectStudents(false).length) return;
      await delay(150);
    }
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    }
    element.click();
  }

  function describeElement(element) {
    return compactText([
      element.tagName,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].filter(Boolean).join(" "));
  }

  function collectMenuTextSample() {
    return Array.from(document.querySelectorAll("[role='listbox'],[role='menu'],[role='dialog']"))
      .filter(isVisible)
      .map((element) => compactText(element.textContent || ""))
      .filter(Boolean)
      .slice(0, 5);
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

async function captureKhanClassBySwitchingStudentsFromPage(startDate, endDate) {
  if (!/khanacademy\.org/i.test(location.hostname)) {
    return { ok: false, reason: "not a Khan frame", url: location.href, results: [] };
  }

  const resultsByKaid = new Map();
  const diagnostics = {
    startedAt: new Date().toISOString(),
    startUrl: location.href,
    switchControlText: "",
    optionLabels: [],
    clickAttempts: []
  };

  const firstCapture = await captureCurrentStudent();
  if (firstCapture.studentKaid) resultsByKaid.set(firstCapture.studentKaid, firstCapture);

  const optionLabels = await collectStudentOptionLabels();
  diagnostics.optionLabels = optionLabels;
  if (!optionLabels.length) {
    return {
      ok: true,
      url: location.href,
      startDate,
      endDate,
      results: Array.from(resultsByKaid.values()),
      diagnostics
    };
  }

  for (const label of optionLabels) {
    const beforeKaid = getStudentKaidFromUrl(location.href);
    const clickResult = await clickStudentOption(label);
    diagnostics.clickAttempts.push({ label, ...clickResult });
    if (!clickResult.ok) continue;

    await waitForStudentRouteChange(beforeKaid, label, 4500);
    await waitForActivityReportSettled(900);

    const capture = await captureCurrentStudent();
    if (capture.studentKaid) {
      if (!capture.studentName || capture.studentName === capture.studentKaid) {
        capture.studentName = label;
      }
      resultsByKaid.set(capture.studentKaid, capture);
    }
  }

  return {
    ok: true,
    url: location.href,
    startDate,
    endDate,
    results: Array.from(resultsByKaid.values()),
    diagnostics
  };

  async function collectStudentOptionLabels() {
    const opened = await openSwitchStudentMenu();
    diagnostics.switchControlText = opened.switchControlText || "";
    if (!opened.ok) return [];

    const labels = new Map();
    for (let pass = 0; pass < 12; pass += 1) {
      for (const option of getStudentOptionElements()) {
        const label = cleanStudentOptionText(option.textContent || option.getAttribute("aria-label") || option.getAttribute("title") || "");
        if (looksLikeStudentOption(label)) labels.set(normalize(label), label);
      }

      const scroller = findScrollableMenu();
      if (!scroller) break;
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(120, scroller.clientHeight - 40), scroller.scrollHeight);
      await delay(180);
      if (Math.abs(scroller.scrollTop - before) < 5) break;
    }

    closeMenus();
    return Array.from(labels.values());
  }

  async function clickStudentOption(label) {
    const opened = await openSwitchStudentMenu();
    if (!opened.ok) return opened;

    const targetKey = normalize(label);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const options = getStudentOptionElements();
      const option = options.find((element) => normalize(cleanStudentOptionText(element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || "")) === targetKey);
      if (option) {
        clickElement(option);
        return { ok: true };
      }

      const scroller = findScrollableMenu();
      if (!scroller) break;
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(120, scroller.clientHeight - 40), scroller.scrollHeight);
      await delay(160);
      if (Math.abs(scroller.scrollTop - before) < 5) break;
    }

    closeMenus();
    return { ok: false, reason: "student option not found after opening menu" };
  }

  async function captureCurrentStudent() {
    const studentKaid = getStudentKaidFromUrl(location.href);
    if (!studentKaid) {
      return {
        ok: false,
        studentKaid: "",
        studentName: inferCurrentStudentName(),
        error: "student kaid not found in current URL",
        sessions: []
      };
    }

    const result = await requestKhanActivityForStudent(studentKaid);
    result.studentName = inferCurrentStudentName() || result.studentName || studentKaid;
    return result;
  }

  async function requestKhanActivityForStudent(studentKaid) {
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

    try {
      const response = await fetch(requestUrl.href, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-ka-fkey": "1"
        },
        body: JSON.stringify({
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
        })
      });

      const responseText = await response.text();
      const json = safeJsonParse(responseText);
      const activityLog = json?.data?.user?.activityLogV2;
      const sessions = activityLog?.activitySessions?.sessions || [];

      if (!response.ok || !activityLog) {
        return {
          ok: false,
          studentKaid,
          studentName: "",
          status: response.status,
          requestUrl: requestUrl.href,
          reason: json?.errors?.[0]?.message || "activityLogV2 missing from Khan response",
          responsePreview: truncateText(responseText, 1200),
          sessions: []
        };
      }

      return {
        ok: true,
        studentKaid,
        studentName: "",
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
        studentName: "",
        requestUrl: requestUrl.href,
        error: error?.message || String(error),
        sessions: []
      };
    }
  }

  async function openSwitchStudentMenu() {
    closeMenus();
    await delay(100);

    const control = findSwitchStudentControl();
    if (!control) return { ok: false, reason: "Switch student control not found" };

    const switchControlText = describeElement(control);
    clickElement(control);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (getStudentOptionElements().length) return { ok: true, switchControlText };
      await delay(120);
    }

    return { ok: false, reason: "Switch student menu did not expose visible student options", switchControlText };
  }

  function findSwitchStudentControl() {
    return Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(isVisible)
      .find((element) => /switch\s*student/i.test(describeElement(element)));
  }

  function getStudentOptionElements() {
    const containers = getMenuContainers();
    const rootElements = containers.length ? containers : [document.body];
    const options = [];
    for (const root of rootElements) {
      options.push(...Array.from(root.querySelectorAll("a,button,[role='option'],[role='menuitem'],[role='menuitemradio'],[tabindex],li,div")));
    }

    return uniqueElements(options)
      .filter(isVisible)
      .filter((element) => looksLikeStudentOption(cleanStudentOptionText(element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || "")));
  }

  function getMenuContainers() {
    return Array.from(document.querySelectorAll("[role='listbox'],[role='menu'],[role='dialog'],[data-radix-popper-content-wrapper]"))
      .filter(isVisible)
      .filter((element) => /[a-z]/i.test(element.textContent || ""));
  }

  function findScrollableMenu() {
    const candidates = [
      ...getMenuContainers(),
      ...getMenuContainers().flatMap((container) => Array.from(container.querySelectorAll("*")))
    ].filter(isVisible);

    return candidates.find((element) => element.scrollHeight > element.clientHeight + 20) || null;
  }

  function closeMenus() {
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch {
      // Best effort only.
    }
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    }
    element.click();
  }

  async function waitForStudentRouteChange(beforeKaid, label, timeoutMs) {
    const targetLabel = normalize(label);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const currentKaid = getStudentKaidFromUrl(location.href);
      const currentName = normalize(inferCurrentStudentName());
      if (currentKaid && currentKaid !== beforeKaid) return true;
      if (currentName && currentName === targetLabel) return true;
      await delay(150);
    }
    return false;
  }

  async function waitForActivityReportSettled(milliseconds) {
    await delay(milliseconds);
  }

  function inferCurrentStudentName() {
    const heading = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
      .filter(isVisible)
      .map((element) => cleanStudentOptionText(element.textContent || ""))
      .find(looksLikeStudentOption);
    if (heading) return heading;

    const selected = Array.from(document.querySelectorAll("[aria-selected='true'], option:checked"))
      .map((element) => cleanStudentOptionText(element.textContent || element.getAttribute("label") || ""))
      .find(looksLikeStudentOption);
    return selected || "";
  }

  function looksLikeStudentOption(value) {
    const text = cleanStudentOptionText(value);
    if (text.length < 3 || text.length > 80) return false;
    if (!/[a-z]/i.test(text)) return false;
    if (/kaid_/i.test(text)) return false;
    if (/\b(report|activity|date|filter|exercise|time on task|dashboard|class|teacher|settings|assignments|skills|overview|search|subjects|minutes|log|switch student|browse|feedback|last 7 days|last week|all time)\b/i.test(text)) return false;
    return true;
  }

  function cleanStudentOptionText(value) {
    return compactText(value)
      .replace(/\b(selected|student|learner)\b/gi, " ")
      .replace(/kaid_[A-Za-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function describeElement(element) {
    return compactText([
      element.tagName,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].filter(Boolean).join(" "));
  }

  function getStudentKaidFromUrl(url) {
    const match = String(url || "").match(/individual-student\/(kaid_[A-Za-z0-9]+)/i);
    return match ? match[1] : "";
  }

  function normalize(value) {
    return compactText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9, ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function compactText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ").trim();
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
