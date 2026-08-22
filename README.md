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
5. Click **Capture Class via Khan API**.
6. Download the CSV if the rows look right.

If Khan does not expose the roster directly, the Khan tab may visibly move from student to student during capture. Leave the Khan tab open until the extension finishes.

## All-classes capture

For weekly use across multiple classes:

1. Paste each Khan class Roster URL into **Saved Classes**.
2. Give each class a short class name.
3. Add the matching Schoology section ID and Schoology assignment ID for each class.
4. Click **Save Classes**.
5. Choose the start and end dates.
6. Click **Capture All Classes**.

The extension opens each saved roster page in a temporary Chrome tab, captures that class, closes the temporary tab, then combines all rows into one table and CSV. The saved class list stays in `chrome.storage.local` on this Chrome profile.

## Schoology grade workflow

Schoology writes are review-first. Capturing Khan data does not send anything to Schoology.

1. Enter the grading settings in **Grading & Schoology**:
   - Grade from: Time on task or Exercises
   - Required minutes
   - Max points
2. Enter the Schoology API base, consumer key, and consumer secret.
3. Click **Save Settings**.
4. Capture Khan rows with **Capture All Classes**.
5. Click **Preview Schoology Grades**.
6. Review each row for:
   - Khan student name
   - Schoology matched enrollment
   - minutes
   - calculated grade
   - status
7. Click **Send Grades to Schoology** only after the preview is correct.

The grade formula is:

```text
grade = min(max points, round(minutes / required minutes * max points))
```

The first Schoology version uses existing assignment IDs. It does not create Schoology assignments automatically.

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
- Khan data is only sent to Schoology after clicking **Send Grades to Schoology** and confirming the write.
- The extension requests access to Khan Academy pages and the official Schoology API host.

## Status

This is still an early teacher workflow tool. Khan capture, local grade preview, Schoology enrollment matching, and reviewed Schoology grade writes are implemented. Assignment creation and Infinite Campus work are intentionally out of scope because the Schoology-to-Infinite-Campus sync handles the final step.
