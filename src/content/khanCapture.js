chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "KHAN_CAPTURE_REPORT") return false;

  try {
    sendResponse({ ok: true, report: getKhanReport() });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || String(error) });
  }

  return false;
});

globalThis.__KHAN_GRADER_CAPTURE__ = getKhanReport;

function getKhanReport() {
  const pageText = getVisiblePageText();
  const selectedText = String(window.getSelection?.() || "");
  const rows = extractKhanRows(pageText);
  const activityRows = extractActivityRows(pageText);
  const dateRangeCandidates = collectDateRangeCandidates(pageText);
  const dateRange = dateRangeCandidates[0] || "";
  const studentSummary = extractStudentSummary(pageText, dateRange);

  return {
    url: location.href,
    title: document.title,
    rows,
    activityRows,
    studentSummary,
    pageKind: inferPageKind(pageText, rows, activityRows, studentSummary),
    dateRange,
    textSample: pageText.slice(0, 6000),
    selectedTextSample: selectedText.slice(0, 2000),
    diagnostics: {
      visibleTextLength: pageText.length,
      selectedTextLength: selectedText.length,
      tableCount: document.querySelectorAll("table").length,
      tableRowCount: document.querySelectorAll("tr").length,
      roleRowCount: document.querySelectorAll('[role="row"]').length,
      iframeCount: document.querySelectorAll("iframe").length,
      shadowRootCount: countShadowRoots(),
      dateRangeCandidates,
      possibleStudentNames: extractPossibleStudentNames(pageText).slice(0, 40)
    }
  };
}

function inferPageKind(pageText, rows, activityRows, studentSummary) {
  const text = String(pageText || "").toLowerCase();
  if (studentSummary.exerciseMinutes !== null || studentSummary.timeOnTaskMinutes !== null) {
    return "individual-student-report";
  }
  if (activityRows.length && /activity|minutes|course|skill|assignment|mastery|practice/.test(text)) {
    return "student-activity";
  }
  if (rows.length && /student|total|date range|time on task/.test(text)) {
    return "class-activity";
  }
  return "unknown";
}

function extractDateRange(pageText) {
  return collectDateRangeCandidates(pageText)[0] || "";
}

function collectDateRangeCandidates(pageText) {
  const lines = getLines(pageText);
  const candidates = [];

  const dateIndex = lines.findIndex((line) => /^date range$/i.test(line) || /date range/i.test(line));
  if (dateIndex >= 0) {
    const next = lines
      .slice(dateIndex + 1, dateIndex + 5)
      .map(extractDateRangeValue)
      .find(Boolean);
    if (next) candidates.push(next);
  }

  const dateFilterIndex = lines.findIndex((line) => /^date filter$/i.test(line) || /date filter/i.test(line));
  if (dateFilterIndex >= 0) {
    const next = lines
      .slice(dateFilterIndex + 1, dateFilterIndex + 7)
      .map(extractDateRangeValue)
      .find(Boolean);
    if (next) candidates.push(next);
  }

  for (const line of lines) {
    const candidate = extractDateRangeValue(line);
    if (candidate) candidates.push(candidate);
  }

  for (const text of getVisibleControlTexts()) {
    const candidate = extractDateRangeValue(text);
    if (candidate) candidates.push(candidate);
  }

  return uniqueCompact(candidates)
    .filter((candidate) => !/^date\s*(range|filter)$/i.test(candidate))
    .slice(0, 20);
}

function getVisibleControlTexts() {
  const selector = [
    "button",
    "[role='button']",
    "[role='combobox']",
    "[role='listbox']",
    "[role='option']",
    "select",
    "option",
    "label",
    "[aria-label]",
    "[title]"
  ].join(",");

  return Array.from(document.querySelectorAll(selector))
    .filter(isVisible)
    .map((element) => compactText([
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.value
    ].filter(Boolean).join(" ")))
    .filter((text) => text && text.length <= 180);
}

function extractDateRangeValue(text) {
  const value = compactText(text);
  if (!value) return "";

  const preset = value.match(/\b(last\s+\d+\s+days|last\s+week|this\s+week|today|yesterday|all\s+time)\b/i);
  if (preset) return titleCaseDatePreset(preset[1]);

  const numericRange = value.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\s*(?:-|to|through|–|—)\s*\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/i);
  if (numericRange) return normalizeDateRangeText(numericRange[0]);

  const month = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
  const namedRange = value.match(new RegExp(`\\b${month}\\s+\\d{1,2}(?:,\\s*\\d{4})?\\s*(?:-|to|through|–|—)\\s*${month}\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, "i"));
  if (namedRange) return normalizeDateRangeText(namedRange[0]);

  return "";
}

function titleCaseDatePreset(value) {
  return compactText(value).toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeDateRangeText(value) {
  return compactText(value).replace(/\s*(?:–|—|to|through)\s*/i, " - ");
}

function uniqueCompact(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(compactText).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function extractStudentSummary(pageText, detectedDateRange = extractDateRange(pageText)) {
  const lines = getLines(pageText);
  const studentName = extractStudentName(lines);
  const exerciseMinutes = findMetricMinutes(lines, /^exercises?$/i, /exercises?/i);
  const timeOnTaskMinutes = findMetricMinutes(lines, /^time\s*on\s*task$/i, /time\s*on\s*task/i);

  return {
    studentName,
    exerciseMinutes,
    timeOnTaskMinutes,
    detectedDateRange,
    sourceText: buildStudentSummarySource(lines, studentName)
  };
}

function extractStudentName(lines) {
  const headingName = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
    .map((element) => compactText(element.innerText || element.textContent || ""))
    .find(looksLikeStudentNameForSummary);
  if (headingName) return headingName;

  const selectedName = Array.from(document.querySelectorAll("[aria-selected='true'], option:checked"))
    .map((element) => compactText(element.innerText || element.textContent || element.getAttribute("label") || ""))
    .find(looksLikeStudentNameForSummary);
  if (selectedName) return selectedName;

  const switchIndex = lines.findIndex((line) => /switch\s*student/i.test(line));
  if (switchIndex >= 0) {
    const nearbyBefore = lines.slice(Math.max(0, switchIndex - 5), switchIndex).reverse().find(looksLikeStudentNameForSummary);
    if (nearbyBefore) return nearbyBefore;

    const nearbyAfter = lines.slice(switchIndex + 1, switchIndex + 8).find(looksLikeStudentNameForSummary);
    if (nearbyAfter) return nearbyAfter;
  }

  return extractPossibleStudentNames(lines.join("\n"))[0] || "";
}

function extractPossibleStudentNames(pageText) {
  const lines = getLines(pageText);
  const names = [];
  for (const line of lines) {
    if (looksLikeStudentNameForSummary(line) && !names.includes(line)) names.push(line);
  }
  return names;
}

function findMetricMinutes(lines, exactLabelPattern, looseLabelPattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!looseLabelPattern.test(line)) continue;

    const sameLine = parseMinutes(line);
    if (sameLine !== null && !exactLabelPattern.test(line)) return sameLine;

    for (let offset = 1; offset <= 5 && index + offset < lines.length; offset += 1) {
      if (isReportLabel(lines[index + offset]) && parseMinutes(lines[index + offset]) === null) break;
      const minutes = parseMinutes(lines[index + offset]);
      if (minutes !== null) return minutes;
    }
  }

  const joined = lines.join(" | ");
  const compact = exactLabelPattern.source.includes("time")
    ? joined.match(/time\s*on\s*task\s*(?:[-:|]|—)?\s*(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i)
    : joined.match(/exercises?\s*(?:[-:|]|—)?\s*(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i);
  return compact ? Math.round(Number(compact[1])) : null;
}

function buildStudentSummarySource(lines, studentName) {
  const interesting = lines.filter((line) => {
    if (studentName && line === studentName) return true;
    return /switch\s*student|last\s*\d+\s*days|date\s*range|activity\s*filter|exercises?|time\s*on\s*task/i.test(line);
  });
  return interesting.slice(0, 20).join(" | ");
}

function looksLikeStudentNameForSummary(value) {
  const line = compactText(value);
  if (line.length < 3 || line.length > 70) return false;
  if (!/[a-z]/i.test(line)) return false;
  if (/\d/.test(line)) return false;
  return !/\b(report|individual|activity|student|switch|date|filter|exercises?|time on task|minutes?|class|teacher|dashboard|course|skill|assignment|progress|overview|settings|search|subjects|last|days|all time|log)\b/i.test(line);
}

function extractKhanRows(pageText) {
  const tableRows = Array.from(document.querySelectorAll("tr"))
    .map(extractFromTableRow)
    .filter(Boolean);

  const roleRows = Array.from(document.querySelectorAll('[role="row"]'))
    .map(extractFromLooseElement)
    .filter(Boolean);

  const selectedRows = extractFromVisibleText(String(window.getSelection?.() || ""));
  const pageTextRows = extractFromVisibleText(pageText);

  return dedupeRows([...selectedRows, ...tableRows, ...roleRows, ...pageTextRows])
    .filter((row) => looksLikeStudent(row.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractActivityRows(pageText) {
  const tableRows = Array.from(document.querySelectorAll("tr"))
    .map((row) => extractActivityFromTableRow(row) || extractActivityFromElement(row))
    .filter(Boolean);

  const roleRows = Array.from(document.querySelectorAll('[role="row"], li'))
    .map(extractActivityFromElement)
    .filter(Boolean);

  const selectedRows = extractActivityFromVisibleText(String(window.getSelection?.() || ""));
  const pageTextRows = extractActivityFromVisibleText(pageText);

  return dedupeActivityRows([...selectedRows, ...tableRows, ...roleRows, ...pageTextRows])
    .sort((a, b) => (a.dateText || "").localeCompare(b.dateText || "") || a.activity.localeCompare(b.activity));
}

function extractActivityFromTableRow(row) {
  if (!isVisible(row)) return null;
  const cells = Array.from(row.querySelectorAll("th,td")).map((cell) => compactText(cell.innerText));
  if (cells.length < 4) return null;

  const dateIndex = cells.findIndex((cell) => parseDateText(cell));
  if (dateIndex < 0) return null;

  const dateText = parseDateText(cells[dateIndex]);
  const activity = inferActivityFromCells(cells, dateIndex);
  const minutes = inferMinutesFromActivityCells(cells, dateIndex);
  if (!activity || minutes === null) return null;

  return {
    dateText,
    activity,
    minutes,
    sourceText: cells.join(" | ")
  };
}

function inferActivityFromCells(cells, dateIndex) {
  const beforeDate = cells.slice(0, dateIndex).filter(Boolean);
  const activity = beforeDate[0] || "";
  const course = beforeDate.slice(1).find((cell) => !isActivityLabel(cell));
  return compactText([activity, course].filter(Boolean).join(" - "));
}

function inferMinutesFromActivityCells(cells, dateIndex) {
  const candidates = cells
    .slice(dateIndex + 1)
    .filter((cell) => !/^\d+\s*\/\s*\d+$/.test(cell))
    .map((cell) => {
      const explicit = parseMinutes(cell);
      if (explicit !== null) return explicit;

      const numeric = compactText(cell).match(/^\d+(?:\.\d+)?$/);
      return numeric ? Math.round(Number(numeric[0])) : null;
    })
    .filter((value) => value !== null);

  return candidates.length ? candidates[0] : null;
}

function extractActivityFromElement(element) {
  if (!isVisible(element)) return null;
  const text = compactText(element.innerText);
  if (!text || text.length > 500) return null;
  return extractActivityFromLooseText(text);
}

function extractActivityFromVisibleText(text) {
  const lines = getLines(text);
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const sameLine = extractActivityFromLooseText(lines[index]);
    if (sameLine) rows.push(sameLine);

    const date = parseDateText(lines[index]);
    if (!date) continue;

    for (let end = index + 1; end <= index + 5 && end < lines.length; end += 1) {
      const sourceText = lines.slice(index, end + 1).join(" | ");
      const candidate = extractActivityFromLooseText(sourceText);
      if (candidate) {
        rows.push(candidate);
        break;
      }
    }
  }

  return rows;
}

function extractActivityFromLooseText(text) {
  const minutes = parseMinutes(text);
  if (minutes === null) return null;

  const dateText = parseDateText(text);
  if (!dateText) return null;

  const activity = inferActivityName(text, dateText);
  if (!activity || isActivityLabel(activity)) return null;

  return {
    dateText,
    activity,
    minutes,
    sourceText: compactText(text)
  };
}

function parseDateText(text) {
  const value = compactText(text);
  const numericDate = value.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/);
  if (numericDate) return numericDate[0];

  const namedDate = value.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?\b/i);
  if (namedDate) return namedDate[0];

  const relativeDate = value.match(/\b(?:today|yesterday)\b/i);
  if (relativeDate) return relativeDate[0];

  return "";
}

function inferActivityName(text, dateText) {
  return compactText(text)
    .replace(dateText, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:learning\s*)?(?:minutes?|mins?|m)\b/gi, " ")
    .replace(/\b\d+\s*(?:hours?|hrs?|h)\s*(?:\d+\s*(?:minutes?|mins?|m))?\b/gi, " ")
    .replace(/\b(completed|started|worked on|practiced|mastered|leveled up|minutes|learning minutes|active minutes)\b/gi, " ")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isActivityLabel(text) {
  return /\b(date|activity|minutes|total|student|report|filter|sort|time on task|course|skill)\b/i.test(String(text || ""));
}

function dedupeActivityRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = [
      compactText(row.dateText).toLowerCase(),
      normalizeName(row.activity),
      row.minutes
    ].join("|");
    const current = byKey.get(key);
    if (!current || row.sourceText.length < current.sourceText.length) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

function extractFromTableRow(row) {
  if (!isVisible(row)) return null;
  const cells = Array.from(row.querySelectorAll("th,td")).map((cell) => compactText(cell.innerText));
  if (cells.length < 2) return null;

  const minuteCell = cells.find((cell) => parseMinutes(cell) !== null);
  if (!minuteCell) return null;

  const nameCell = cells.find((cell) => cell !== minuteCell && looksLikeStudent(cell));
  if (!nameCell) return null;

  return {
    name: cleanName(nameCell),
    minutes: parseMinutes(minuteCell),
    sourceText: cells.join(" | ")
  };
}

function extractFromLooseElement(element) {
  if (!isVisible(element)) return null;
  const text = compactText(element.innerText);
  if (!text || text.length > 240) return null;

  const minutes = parseMinutes(text);
  if (minutes === null) return null;

  const name = inferNameFromText(text);
  if (!name) return null;

  return { name, minutes, sourceText: text };
}

function extractFromVisibleText(text) {
  const lines = getLines(text);
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const sameLine = extractFromLooseText(lines[index]);
    if (sameLine) rows.push(sameLine);

    if (!looksLikeStudent(lines[index])) continue;

    for (let offset = 1; offset <= 5 && index + offset < lines.length; offset += 1) {
      const minutes = parseMinutes(lines[index + offset]);
      if (minutes === null || isReportLabel(lines[index + offset])) continue;

      rows.push({
        name: cleanName(lines[index]),
        minutes,
        sourceText: lines.slice(index, index + offset + 1).join(" | ")
      });
      break;
    }
  }

  return rows;
}

function extractFromLooseText(text) {
  const minutes = parseMinutes(text);
  if (minutes === null) return null;

  const name = inferNameFromText(text);
  if (!name) return null;

  return { name, minutes, sourceText: text };
}

function inferNameFromText(text) {
  const withoutMinutes = text
    .replace(/\b\d+(?:\.\d+)?\s*(?:learning\s*)?(?:minutes?|mins?|m)\b/gi, " ")
    .replace(/\b\d+\s*(?:hours?|hrs?|h)\s*(?:\d+\s*(?:minutes?|mins?|m))?\b/gi, " ")
    .replace(/\bactive\b|\blearning\b|\bminutes\b|\btotal\b|\bweek\b/gi, " ");

  const candidates = withoutMinutes
    .split(/\n|\|| {2,}/)
    .map(cleanName)
    .filter(looksLikeStudent);

  return candidates[0] || null;
}

function parseMinutes(text) {
  const value = compactText(text).toLowerCase();

  const hourMinute = value.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m))?\b/i);
  if (hourMinute) {
    return Math.round(Number(hourMinute[1]) * 60 + Number(hourMinute[2] || 0));
  }

  const minute = value.match(/\b(\d+(?:\.\d+)?)\s*(?:learning\s*)?(?:minutes?|mins?|m)\b/i);
  if (minute) return Math.round(Number(minute[1]));

  const numeric = value.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (numeric) return Math.round(Number(numeric[1]));

  return null;
}

function dedupeRows(rows) {
  const bestByName = new Map();
  for (const row of rows) {
    const key = normalizeName(row.name);
    if (!key) continue;
    const current = bestByName.get(key);
    if (!current || row.sourceText.length < current.sourceText.length) {
      bestByName.set(key, row);
    }
  }
  return Array.from(bestByName.values());
}

function looksLikeStudent(text) {
  const value = compactText(text);
  if (!value || value.length < 3 || value.length > 70) return false;
  if (!/[a-z]/i.test(value)) return false;
  if (isReportLabel(value)) return false;
  return true;
}

function isReportLabel(text) {
  return /\b(total|average|minutes|learning|active|assignment|course|student name|date range|progress|report|teacher|class|settings|sort|filter|mastery|skill|score|practice|last active|dashboard|browse subjects|search|overview)\b/i.test(String(text || ""));
}

function cleanName(value) {
  return compactText(value)
    .replace(/\b(student|learner)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => compactText(line))
    .filter(Boolean);
}

function compactText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function normalizeName(value) {
  return cleanName(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function getVisiblePageText() {
  const pieces = [document.body?.innerText || ""];
  collectShadowText(document.documentElement, pieces);
  return compactText(pieces.join("\n"));
}

function collectShadowText(root, pieces) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    if (node.shadowRoot) {
      pieces.push(node.shadowRoot.textContent || "");
      collectShadowText(node.shadowRoot, pieces);
    }
    node = walker.nextNode();
  }
}

function countShadowRoots() {
  let count = 0;
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    if (node.shadowRoot) count += 1;
    node = walker.nextNode();
  }
  return count;
}
