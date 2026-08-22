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

  return {
    url: location.href,
    title: document.title,
    rows,
    dateRange: extractDateRange(pageText),
    textSample: pageText.slice(0, 6000),
    selectedTextSample: selectedText.slice(0, 2000),
    diagnostics: {
      visibleTextLength: pageText.length,
      selectedTextLength: selectedText.length,
      tableCount: document.querySelectorAll("table").length,
      tableRowCount: document.querySelectorAll("tr").length,
      roleRowCount: document.querySelectorAll('[role="row"]').length,
      iframeCount: document.querySelectorAll("iframe").length,
      shadowRootCount: countShadowRoots()
    }
  };
}

function extractDateRange(pageText) {
  const lines = getLines(pageText);
  const dateIndex = lines.findIndex((line) => /^date range$/i.test(line) || /date range/i.test(line));
  if (dateIndex >= 0) {
    const next = lines
      .slice(dateIndex + 1, dateIndex + 5)
      .find((line) => /last|today|yesterday|days|week|month|\/|-| to /i.test(line));
    if (next) return next;
  }

  return lines.find((line) => /^(last \d+ days|last week|this week|today|yesterday|all time)$/i.test(line)) || "";
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
