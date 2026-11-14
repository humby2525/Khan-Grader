const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/dashboard/dashboard.js"), "utf8");

function harness() {
  const writes = [];
  const context = {
    document: { addEventListener() {} },
    chrome: { storage: { local: { set: async (data) => writes.push(data) } } },
    Date,
    console
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "dashboard.js" });
  const api = vm.runInContext([
    "({",
    "  elements, setDefaultWeek, calculateGrade, formatSchoologyDueDate,",
    "  buildGradePreviewRow, buildSchoologyPreview, resolveGradingAssignmentForWeek,",
    "  getWeekMap() { return assignmentsByWeek; },",
    "  setWeekMap(value) { assignmentsByWeek = value; },",
    "  setCapture(value) { lastCapture = value; },",
    "  setMocks({ getAssignment, listAssignments, getEnrollments }) {",
    "    fetchSchoologyAssignment = getAssignment;",
    "    fetchSchoologyAssignments = listAssignments;",
    "    fetchSchoologyEnrollments = getEnrollments;",
    "  }",
    "})"
  ].join("\n"), context);
  return { api, writes };
}

test("weekend and weekday defaults keep grading and preparation independent", () => {
  const { api } = harness();
  for (const id of ["weekStart", "weekEnd", "prepareWeekStart", "prepareWeekEnd"]) {
    api.elements[id] = { value: "" };
  }
  api.elements.prepareDueSummary = { textContent: "" };
  const cases = [
    [new Date(2026, 10, 14), ["2026-11-09", "2026-11-13", "2026-11-16", "2026-11-20"]],
    [new Date(2026, 10, 15), ["2026-11-09", "2026-11-13", "2026-11-16", "2026-11-20"]],
    [new Date(2026, 10, 16), ["2026-11-09", "2026-11-13", "2026-11-23", "2026-11-27"]],
    [new Date(2026, 2, 8), ["2026-03-02", "2026-03-06", "2026-03-09", "2026-03-13"]],
    [new Date(2026, 10, 1), ["2026-10-26", "2026-10-30", "2026-11-02", "2026-11-06"]]
  ];
  for (const [date, expected] of cases) {
    api.setDefaultWeek(date);
    assert.deepEqual(
      ["weekStart", "weekEnd", "prepareWeekStart", "prepareWeekEnd"].map((key) => api.elements[key].value),
      expected
    );
    assert.match(api.elements.prepareDueSummary.textContent, /11:59 PM/);
  }
  assert.equal(api.formatSchoologyDueDate("2026-11-20", "23:59"), "2026-11-20 23:59:00");
});

test("each class independently uses full-credit-or-zero or proportional points", () => {
  const { api } = harness();
  assert.equal(api.calculateGrade(49, 50, 100, "pass_fail"), 0);
  assert.equal(api.calculateGrade(50, 50, 100, "pass_fail"), 100);
  assert.equal(api.calculateGrade(65, 50, 100, "pass_fail"), 100);
  assert.equal(api.calculateGrade(49, 50, 100, "proportional"), 98);
  assert.equal(api.calculateGrade(20, 50, 100), 40);
  const grading = { metric: "timeOnTaskMinutes", metricLabel: "Time on task", targetMinutes: 50, maxPoints: 100 };
  const student = { className: "804", studentName: "Jane Doe", timeOnTaskMinutes: 49, detectedDateRange: "Nov 9–13" };
  const pass = api.buildGradePreviewRow(student, { gradingMethod: "pass_fail", targetMinutes: 50 }, grading);
  const proportional = api.buildGradePreviewRow(student, { gradingMethod: "proportional", targetMinutes: 50 }, grading);
  assert.equal(pass.grade, 0);
  assert.equal(proportional.grade, 98);
  assert.equal(pass.assignmentId, "");
  assert.equal(proportional.assignmentId, "");
});

test("missing Khan minutes cannot be treated as a zero for pass/fail", () => {
  const { api } = harness();
  const grading = { metric: "timeOnTaskMinutes", metricLabel: "Time on task", targetMinutes: 50, maxPoints: 100 };
  const row = api.buildGradePreviewRow(
    { className: "804", studentName: "Jane Doe", timeOnTaskMinutes: null },
    { gradingMethod: "pass_fail", targetMinutes: 50, schoologyAssignmentId: "any" },
    grading
  );
  assert.equal(row.status, "missing_minutes");
  assert.equal(row.grade, null);
  assert.equal(row.assignmentId, "");
});

test("preparing next week cannot redirect last week's grades", async () => {
  const { api, writes } = harness();
  const assignments = {
    next: { id: "next", title: "Khan Minutes - Week of Nov 16", published: 1, count_in_grade: 1, max_points: 100 },
    last: { id: "last", title: "Khan Minutes - Week of Nov 9", published: 1, count_in_grade: 1, max_points: 100 }
  };
  let listCalls = 0;
  api.setMocks({
    getAssignment: async (_section, id) => assignments[id],
    listAssignments: async () => { listCalls += 1; return { assignments: Object.values(assignments) }; },
    getEnrollments: async () => [{ id: "enrollment-1", name_display: "Jane Doe", name_first: "Jane", name_last: "Doe", status: 1 }]
  });
  api.setWeekMap({});
  api.setCapture({ expectedWeekStart: "2026-11-09", expectedWeekEnd: "2026-11-13", dateRange: "2026-11-09 - 2026-11-13" });
  const classConfig = { name: "804", schoologySectionId: "123", schoologyAssignmentId: "next", gradingMethod: "pass_fail", targetMinutes: 50 };
  const settings = { assignmentTitleTemplate: "Khan Minutes - Week of {startDate}", gradeMetric: "timeOnTaskMinutes", gradeTargetMinutes: 50, gradeMaxPoints: 100 };
  const students = [{ className: "804", studentName: "Jane Doe", timeOnTaskMinutes: 49, detectedDateRange: "2026-11-09 - 2026-11-13" }];
  const preview = await api.buildSchoologyPreview(students, [classConfig], settings);
  assert.equal(preview.rows[0].status, "ready");
  assert.equal(preview.rows[0].assignmentId, "last");
  assert.equal(preview.rows[0].grade, 0);
  assert.equal(api.getWeekMap()["123|2026-11-09|2026-11-13"], "last");
  assert.ok(writes.length > 0);
  students[0].timeOnTaskMinutes = 50;
  const second = await api.buildSchoologyPreview(students, [classConfig], settings);
  assert.equal(second.rows[0].grade, 100);
  assert.equal(second.rows[0].assignmentId, "last");
  assert.equal(listCalls, 1);
});

test("ambiguous or unusable assignments block grade sends", async () => {
  const { api } = harness();
  api.setWeekMap({});
  const base = { name: "804", schoologySectionId: "123", schoologyAssignmentId: "" };
  const settings = { assignmentTitleTemplate: "Khan Minutes - Week of {startDate}", gradeMaxPoints: 100 };
  api.setMocks({
    getAssignment: async (_section, id) => ({ id, title: "Khan Minutes - Week of Nov 9", published: 1, count_in_grade: 1, max_points: 100 }),
    listAssignments: async () => ({ assignments: [
      { id: "a", title: "Khan Minutes - Week of Nov 9" },
      { id: "b", title: "Khan Minutes - Week of Nov 9" }
    ] }),
    getEnrollments: async () => []
  });
  const result = await api.resolveGradingAssignmentForWeek(base, settings, "2026-11-09", "2026-11-13");
  assert.equal(result.assignmentId, "");
  assert.match(result.error, /Multiple/);
});
