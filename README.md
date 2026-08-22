# Khan Grader

Khan Grader is a Manifest V3 Chrome extension for capturing student activity minutes from Khan Academy.

This first version is intentionally Khan-only. It does not connect to Schoology, Infinite Campus, or any outside server.

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
- The extension does not send Khan data to a remote server.
- The extension only requests access to Khan Academy pages.

## Status

This is a capture proof of concept. The current milestone is structured API capture for one student from the Individual Student Report and full-class capture from the Khan Roster page.
