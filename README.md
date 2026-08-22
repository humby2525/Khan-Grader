# Khan Grader

Khan Grader is a Manifest V3 Chrome extension for capturing student activity minutes from Khan Academy, converting those minutes into simple point grades, and sending reviewed grades to an existing Schoology assignment.

## One-student workflow

1. Open Khan Academy.
2. Go to Reports -> Individual Student Report -> Activity log.
3. Choose the student in Khan.
4. Open the Khan Grader extension dashboard.
5. Choose the start and end dates in Khan Grader.
6. Click **Capture via Khan API**.
7. Review the detected student name, Exercises minutes, Time on task minutes, Khan date range, and diagnostics.
8. Export CSV if needed.

The older **Capture Current Student** button is still available as a rendered-page fallback, but the preferred test path is now **Capture via Khan API**. That API capture uses Khan's logged-in browser session and sends the selected dates directly to Khan's Individual Student Report request. It does not store a Khan or Google password.

## Class API capture

For a full class, start from the Khan class **Roster** page. That page exposes the student list more reliably than the Individual Student Report switcher.

The class capture:

1. Looks for student Khan IDs on the current Khan page, preferably the class Roster page.
2. Opens the Khan **Switch student** control as a fallback if needed.
3. Collects every student `kaid` it can see.
4. If the IDs are not exposed directly, it clicks through the visible Switch-student options and reads each student's URL.
5. Requests the same start/end date report for each student.
6. Displays one row per student and exports a class CSV.

Recommended class workflow:

1. Open Khan Academy.
2. Go to your class **Roster** page.
3. Open Khan Grader.
4. Choose the start and end dates.
5. Open **Individual Khan tools** and click **Capture Current Class**.
6. Download the CSV if the rows look right.

If Khan does not expose the roster directly, the Khan tab may visibly move from student to student during capture. Leave the Khan tab open until the extension finishes.

## All-classes capture

For weekly use across multiple classes:

1. Open **Setup** and paste each Khan class roster URL into **Classes**.
2. Give each class a short class name.
3. Optionally add class-specific goal minutes. Blank uses the default required minutes.
4. Add the matching Schoology section ID for each class.
5. Click **Save Classes**.
6. Choose the start and end dates.
7. Click **Capture Minutes**.

The extension opens each saved roster page in a temporary Chrome tab, captures that class, closes the temporary tab, then combines all rows into one table and CSV. The saved class list stays in `chrome.storage.local` on this Chrome profile.

## Schoology grade workflow

Schoology writes are review-first. Capturing Khan data does not send anything to Schoology.

1. Open **Setup** and enter the settings under **Assignment & Grading**:
   - Grade from: Time on task or Exercises
   - Default required minutes
   - Max points
   - Assignment due date and due time
   - Grading category, grading task, and grading period, if your Schoology setup requires them
2. Enter the API base, consumer key, and consumer secret under **Schoology Connection**.
3. Click **Save Schoology Settings**.
4. Capture Khan rows with **Capture Minutes**.
5. Click **Review Grades**.
6. Review each row for:
   - Khan student name
   - Schoology matched enrollment
   - minutes
   - calculated grade
   - status
7. Click **Send Grades** only after the preview is correct.

The grade formula is:

```text
grade = min(max points, round(minutes / goal minutes * max points))
```

Each saved class can have its own goal minutes. If a class goal is blank, the extension uses the default required minutes.

## Prepare Schoology assignments

Use **Create Assignments** before the week starts if you want students to see the Khan assignment in Schoology.

Set up Schoology choices once for each class:

1. Enter the Schoology API key and secret under **Setup**, then save the Schoology settings.
2. Add each class's Schoology section ID under **Classes**.
3. Click **Refresh Categories & Periods** to load the category and grading-period choices from each section.
4. Choose the category and period for each class, enter its task ID if needed, and click **Save Classes**.
5. Refresh these choices again only when adding a class or changing to a new marking period.

For each weekly assignment:

1. Choose the week start and end dates.
2. Enter an assignment title template, such as `Khan Minutes - Week of {startDate}`.
3. Enter a due date and due time. If due date is blank, the extension uses the selected week end date.
4. Click **Create Assignments**.

The extension checks each section for an existing assignment with the exact same title. If it finds one, it reuses that assignment ID only when it also matches the selected assignment settings. If it does not find one, it creates a published, count-in-grade assignment using the max points, due date, due time, grading category, and grading period from the grading settings and saves the returned assignment ID internally. The assignment description tells students to spend the class goal minutes on Khan that week.

Schoology category, period, and task IDs can differ by section even when the visible name is the same. For that reason, category, period, and optional task ID are saved with each class. The assignment ID is hidden because the extension manages it after **Create Assignments**.

After finding or creating each assignment, the extension fetches it back from Schoology and shows the published, available, count-in-grade, due date, category, period, points, and API self link in the assignment results table. If Schoology still returns an old matching title that is not usable, the extension marks it as skipped and creates a new assignment. If the Schoology page does not show the assignment, copy the Network Probe output after running **Create Assignments**.

Schoology's public assignment API documents `grading_category` and `grading_period` for assignment creation. It does not document a matching assignment field or option endpoint for the Schoology UI's grading task dropdown. The extension includes the optional per-class task ID in assignment creation, but your Schoology tenant may reject or ignore it.

Supported title placeholders:

```text
{startDate}  example: Aug 24
{endDate}    example: Aug 30
{startIso}   example: 2026-08-24
{endIso}     example: 2026-08-30
```

## Schoology-only test mode

Use this when Schoology has the current roster but Khan does not yet.

1. Use **Create Assignments** to create a temporary test assignment.
2. Enter a fake value in **Test minutes**.
3. Click **Preview Test Grades**.
4. Confirm that the roster names, enrollment IDs, and calculated grades look right.
5. Click **Send Grades** only if the created assignment is a test assignment.

This test mode does not use Khan data. It pulls active member enrollments from Schoology, calculates grades from the fake test minutes value, and writes comments beginning with `TEST Khan Grader`.

## Network probe

Use the network probe to test whether Khan sends report dates in its own request data.

1. Open the Individual Student Report in Khan.
2. Open Khan Grader.
3. Click **Start Network Probe**.
4. Return to Khan and change the date filter.
5. Return to Khan Grader and click **Collect Network Probe**.
6. Copy the probe output and inspect candidate request URLs, request bodies, and JSON shapes for `startDate`, `endDate`, or similar fields.

The probe runs only in the current browser session and stores output locally in the extension page.

## Privacy

- Student data stays in `chrome.storage.local` on the browser profile where the extension is installed.
- The extension does not store Google passwords.
- Schoology API keys are stored in `chrome.storage.local` on this Chrome profile.
- Khan data is only sent to Schoology after clicking **Send Grades** and confirming the write.
- The extension requests access to Khan Academy pages and the official Schoology API host.

## Status

This is still an early teacher workflow tool. Khan capture, local grade preview, Schoology enrollment matching, and reviewed Schoology grade writes are implemented. Assignment creation and Infinite Campus work are intentionally out of scope because the Schoology-to-Infinite-Campus sync handles the final step.
