import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const defaultProfileDir = path.join(rootDir, ".pw-khan-profile");
const defaultCaptureDir = path.join(rootDir, "captures");

const args = parseArgs(process.argv.slice(2));
const startDate = args.start || args.startDate;
const endDate = args.end || args.endDate;
const startUrl = args.url || "https://classroom.khanacademy.org/";
const profileDir = path.resolve(args.profile || defaultProfileDir);
const captureDir = path.resolve(args.out || defaultCaptureDir);

if (!startDate || !endDate) {
  console.error("Missing dates. Example:");
  console.error("  npm run capture:one -- --start 2026-08-17 --end 2026-08-23");
  process.exit(1);
}

assertIsoDate(startDate, "start");
assertIsoDate(endDate, "end");

await fs.mkdir(profileDir, { recursive: true });
await fs.mkdir(captureDir, { recursive: true });

const rl = readline.createInterface({ input, output });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 950 },
  acceptDownloads: true
});

const page = context.pages()[0] || await context.newPage();
const networkCapture = createNetworkCapture(page);

try {
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });

  console.log("\nKhan Grader one-student proof of concept");
  console.log("Chrome opened with a persistent local profile:");
  console.log(`  ${profileDir}`);
  console.log("\nIf Khan asks you to sign in, sign in normally in the Chrome window.");
  console.log("Navigate to: Reports -> Individual Student Report -> Activity log.");
  console.log("Leave one student selected, then come back here.");
  await rl.question("\nPress Enter when the Individual Student Report Activity log is visible...");

  await waitForKhanPage(page);

  console.log(`\nSetting custom date range: ${startDate} to ${endDate}`);
  const dateResult = await setCustomDateRange(page, startDate, endDate);
  console.log(dateResult.ok ? `Date range set attempt: ${dateResult.message}` : `Date range warning: ${dateResult.message}`);

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const report = await captureCurrentStudent(page, { startDate, endDate });
  const network = networkCapture.snapshot();
  const outputPayload = {
    capturedAt: new Date().toISOString(),
    requestedDateRange: { startDate, endDate },
    dateRangeSetResult: dateResult,
    report,
    network
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(captureDir, `one-student-${stamp}.json`);
  const csvPath = path.join(captureDir, `one-student-${stamp}.csv`);
  await fs.writeFile(jsonPath, `${JSON.stringify(outputPayload, null, 2)}\n`, "utf8");
  await fs.writeFile(csvPath, toOneStudentCsv(report, startDate, endDate), "utf8");

  console.log("\nResult:");
  console.log("Student Name | Exercise Minutes | Time on Task");
  console.log(`${report.studentName || "Not detected"} | ${formatMinutes(report.exerciseMinutes)} | ${formatMinutes(report.timeOnTaskMinutes)}`);
  console.log("\nSaved:");
  console.log(`  ${jsonPath}`);
  console.log(`  ${csvPath}`);
  console.log(`\nStructured JSON responses inspected: ${network.structuredCandidates.length}`);
  console.log("Review the JSON file to see whether Khan returned usable structured minute data.");
} finally {
  await rl.question("\nPress Enter to close the browser...");
  await context.close();
  rl.close();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=");
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = inlineValue ?? argv[index + 1];
    parsed[key] = value;
    if (inlineValue === undefined) index += 1;
  }
  return parsed;
}

function assertIsoDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${label} date "${value}". Use YYYY-MM-DD.`);
  }
}

async function waitForKhanPage(page) {
  await page.waitForFunction(() => /khanacademy\.org/i.test(location.hostname), null, { timeout: 30000 });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}

async function setCustomDateRange(page, startDate, endDate) {
  const frames = page.frames();
  const errors = [];

  for (const frame of frames) {
    try {
      const result = await setCustomDateRangeInFrame(frame, startDate, endDate);
      if (result.ok) return { ...result, frameUrl: frame.url() };
      errors.push(`${frame.url()}: ${result.message}`);
    } catch (error) {
      errors.push(`${frame.url()}: ${error.message || String(error)}`);
    }
  }

  return {
    ok: false,
    message: `Could not set Khan custom dates in any frame. ${errors.slice(0, 3).join(" | ")}`
  };
}

async function setCustomDateRangeInFrame(frame, startDate, endDate) {
  const opened = await clickFirstTextMatch(frame, [
    /last\s*7\s*days/i,
    /last\s*\d+\s*days/i,
    /date\s*range/i,
    /this\s*week/i,
    /all\s*time/i
  ], { timeout: 2500 });

  if (!opened) {
    return { ok: false, message: "No visible Khan date filter trigger found." };
  }

  await frame.page().waitForTimeout(700);

  await clickFirstTextMatch(frame, [
    /custom\s*range/i,
    /custom\s*date/i,
    /^custom$/i
  ], { timeout: 1800 }).catch(() => false);

  await frame.page().waitForTimeout(500);

  const fillResult = await fillDateInputs(frame, startDate, endDate);
  if (!fillResult.ok) return fillResult;

  await clickFirstTextMatch(frame, [
    /^apply$/i,
    /^update$/i,
    /^done$/i,
    /^save$/i
  ], { timeout: 2500 }).catch(() => false);

  return { ok: true, message: "custom date controls were filled" };
}

async function clickFirstTextMatch(frame, patterns, options = {}) {
  const timeout = options.timeout ?? 2000;
  const deadline = Date.now() + timeout;
  const selector = [
    "button",
    "[role='button']",
    "[role='menuitem']",
    "[role='option']",
    "a",
    "label",
    "summary",
    "[tabindex]"
  ].join(",");

  while (Date.now() < deadline) {
    const handles = await frame.$$(selector);
    for (const handle of handles) {
      const info = await handle.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
          text: [
            element.innerText,
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title")
          ].filter(Boolean).join(" ")
        };
      }).catch(() => null);

      if (!info?.visible) continue;
      if (!patterns.some((pattern) => pattern.test(info.text || ""))) continue;

      await handle.scrollIntoViewIfNeeded().catch(() => {});
      await handle.click({ timeout: 1000 }).catch(async () => {
        await handle.evaluate((element) => element.click());
      });
      return true;
    }
    await frame.page().waitForTimeout(200);
  }

  return false;
}

async function fillDateInputs(frame, startDate, endDate) {
  const result = await frame.evaluate(({ startDate: start, endDate: end }) => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };

    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    };

    const candidates = Array.from(document.querySelectorAll("input"))
      .filter(isVisible)
      .filter((input) => !["hidden", "checkbox", "radio", "button", "submit", "search"].includes((input.type || "").toLowerCase()));

    const nativeDateInputs = candidates.filter((input) => input.type === "date");
    if (nativeDateInputs.length >= 2) {
      setValue(nativeDateInputs[0], start);
      setValue(nativeDateInputs[1], end);
      return { ok: true, strategy: "native date inputs" };
    }

    const textInputs = candidates.filter((input) => ["", "text"].includes((input.type || "text").toLowerCase()));
    if (textInputs.length >= 2) {
      setValue(textInputs[0], formatUsDate(start));
      setValue(textInputs[1], formatUsDate(end));
      return { ok: true, strategy: "text inputs" };
    }

    return {
      ok: false,
      message: `No usable start/end date inputs found. Visible non-hidden inputs: ${candidates.length}`
    };

    function formatUsDate(isoDate) {
      const [year, month, day] = isoDate.split("-");
      return `${Number(month)}/${Number(day)}/${year}`;
    }
  }, { startDate, endDate });

  return result.ok ? { ok: true, message: `filled ${result.strategy}` } : result;
}

async function captureCurrentStudent(page, dateRange) {
  const frameReports = [];
  for (const frame of page.frames()) {
    const report = await frame.evaluate(extractStudentReportFromDocument, dateRange).catch((error) => ({
      error: error.message || String(error),
      url: frame.url()
    }));
    frameReports.push({ frameUrl: frame.url(), ...report });
  }

  const best = frameReports
    .filter((report) => !report.error)
    .sort((a, b) => scoreStudentReport(b) - scoreStudentReport(a))[0];

  if (!best) {
    return {
      studentName: "",
      exerciseMinutes: null,
      timeOnTaskMinutes: null,
      frameReports
    };
  }

  return {
    studentName: best.studentName,
    exerciseMinutes: best.exerciseMinutes,
    timeOnTaskMinutes: best.timeOnTaskMinutes,
    detectedDateRange: best.detectedDateRange,
    pageUrl: page.url(),
    frameUrl: best.url,
    textSample: best.textSample,
    frameReports
  };
}

function scoreStudentReport(report) {
  let score = 0;
  if (report.studentName) score += 10;
  if (Number.isFinite(report.exerciseMinutes)) score += 20;
  if (Number.isFinite(report.timeOnTaskMinutes)) score += 20;
  if (/individual|student|activity|time on task|exercises/i.test(report.textSample || "")) score += 5;
  return score;
}

function extractStudentReportFromDocument(dateRange) {
  const text = compactText(document.body?.innerText || "");
  const lines = text.split(/\r?\n/).map(compactText).filter(Boolean);

  return {
    url: location.href,
    title: document.title,
    studentName: findStudentName(lines),
    exerciseMinutes: findMetricMinutes(lines, /exercises?/i),
    timeOnTaskMinutes: findMetricMinutes(lines, /time\s*on\s*task/i),
    detectedDateRange: findDetectedDateRange(lines),
    expectedDateRange: dateRange,
    textLength: text.length,
    textSample: lines.slice(0, 180).join("\n")
  };

  function findStudentName(pageLines) {
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
      .map((element) => compactText(element.innerText || element.textContent || ""))
      .filter(looksLikeName);
    if (headings.length) return headings[0];

    const switchIndex = pageLines.findIndex((line) => /switch\s*student/i.test(line));
    if (switchIndex >= 0) {
      const nearby = pageLines.slice(Math.max(0, switchIndex - 4), switchIndex + 6).filter(looksLikeName);
      if (nearby.length) return nearby[0];
    }

    const selectedOption = Array.from(document.querySelectorAll("[aria-selected='true'], option:checked"))
      .map((element) => compactText(element.innerText || element.textContent || element.getAttribute("label") || ""))
      .find(looksLikeName);
    return selectedOption || "";
  }

  function findMetricMinutes(pageLines, labelPattern) {
    for (let index = 0; index < pageLines.length; index += 1) {
      if (!labelPattern.test(pageLines[index])) continue;
      for (let offset = 0; offset <= 4 && index + offset < pageLines.length; offset += 1) {
        const minutes = parseMinutes(pageLines[index + offset]);
        if (minutes !== null) return minutes;
      }
    }
    return null;
  }

  function findDetectedDateRange(pageLines) {
    const index = pageLines.findIndex((line) => /last\s*\d+\s*days|date\s*range|custom/i.test(line));
    return index >= 0 ? pageLines.slice(index, index + 4).join(" | ") : "";
  }

  function looksLikeName(value) {
    const line = compactText(value);
    if (line.length < 3 || line.length > 70) return false;
    if (!/[a-z]/i.test(line)) return false;
    return !/\b(report|activity|student|switch|date|filter|exercises?|time on task|minutes?|class|teacher|dashboard)\b/i.test(line);
  }

  function parseMinutes(value) {
    const line = compactText(value).toLowerCase();
    const hours = line.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m))?/i);
    if (hours) return Math.round(Number(hours[1]) * 60 + Number(hours[2] || 0));

    const minutes = line.match(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i);
    if (minutes) return Math.round(Number(minutes[1]));

    const numberOnly = line.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
    return numberOnly ? Math.round(Number(numberOnly[1])) : null;
  }

  function compactText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  }
}

function createNetworkCapture(page) {
  const candidates = [];

  page.on("response", async (response) => {
    const request = response.request();
    const url = response.url();
    const contentType = response.headers()["content-type"] || "";
    if (!/khanacademy\.org/i.test(url)) return;
    if (!/json|graphql/i.test(contentType) && !/graphql|api|report|activity|progress/i.test(url)) return;

    try {
      const bodyText = await response.text();
      if (!bodyText || bodyText.length > 2_000_000) return;

      const json = JSON.parse(bodyText);
      const summary = summarizeJson(json);
      if (!summary.score) return;

      candidates.push({
        capturedAt: new Date().toISOString(),
        url,
        method: request.method(),
        status: response.status(),
        contentType,
        score: summary.score,
        matchedPaths: summary.matchedPaths.slice(0, 80),
        sample: summary.sample
      });
    } catch {
      // Ignore non-JSON and one-shot response bodies.
    }
  });

  return {
    snapshot() {
      return {
        structuredCandidates: candidates
          .slice()
          .sort((a, b) => b.score - a.score)
          .slice(0, 25)
      };
    }
  };
}

function summarizeJson(value) {
  const matchedPaths = [];
  const sample = {};
  const terms = /student|exercise|time.?on.?task|minute|duration|activity|skill|course|total/i;

  walk(value, "$", 0);

  return {
    score: matchedPaths.length,
    matchedPaths,
    sample
  };

  function walk(current, currentPath, depth) {
    if (depth > 8 || matchedPaths.length > 200) return;

    if (Array.isArray(current)) {
      current.slice(0, 20).forEach((item, index) => walk(item, `${currentPath}[${index}]`, depth + 1));
      return;
    }

    if (!current || typeof current !== "object") return;

    for (const [key, child] of Object.entries(current)) {
      const childPath = `${currentPath}.${key}`;
      if (terms.test(key) || (typeof child !== "object" && terms.test(String(child)))) {
        matchedPaths.push(childPath);
        if (Object.keys(sample).length < 30) sample[childPath] = typeof child === "object" ? summarizeShape(child) : child;
      }
      walk(child, childPath, depth + 1);
    }
  }
}

function summarizeShape(value) {
  if (Array.isArray(value)) return `[array length ${value.length}]`;
  if (!value || typeof value !== "object") return value;
  return `{${Object.keys(value).slice(0, 8).join(", ")}}`;
}

function toOneStudentCsv(report, startDate, endDate) {
  return [
    "Start Date,End Date,Student Name,Exercise Minutes,Time On Task Minutes,Detected Date Range,Page URL,Frame URL",
    [
      startDate,
      endDate,
      report.studentName || "",
      report.exerciseMinutes ?? "",
      report.timeOnTaskMinutes ?? "",
      report.detectedDateRange || "",
      report.pageUrl || "",
      report.frameUrl || ""
    ].map(csvCell).join(",")
  ].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatMinutes(value) {
  return value === null || value === undefined ? "Not detected" : String(value);
}
