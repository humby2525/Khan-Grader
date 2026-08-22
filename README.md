# Khan Grader

Khan Grader is a Manifest V3 Chrome extension for capturing student minutes from Khan Academy's Individual Student Report.

This first version is intentionally Khan-only. It does not connect to Schoology, Infinite Campus, or any outside server.

## Current workflow

1. Open Khan Academy.
2. Go to Reports -> Individual Student Report -> Activity log.
3. Choose the student and date range in Khan.
4. Open the Khan Grader extension dashboard.
5. Click **Capture Current Student**.
6. Review the detected student name, Exercises minutes, Time on task minutes, Khan date range, and diagnostics.
7. Export CSV if needed.

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

This is a capture proof of concept. The main goal is to reliably read the visible Individual Student Report before automating student switching.
