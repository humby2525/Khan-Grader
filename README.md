# Khan Grader

Khan Grader is a Manifest V3 Chrome extension for capturing student learning minutes from a Khan Academy teacher Activity Report.

This first version is intentionally Khan-only. It does not connect to Schoology, Infinite Campus, or any outside server.

## Current workflow

1. Open your Khan Academy teacher Activity Report.
2. Set the Khan date range in Khan.
3. Open the Khan Grader extension dashboard.
4. Click **Capture Current Khan Tab**.
5. Review the detected students, minutes, Khan date range, and diagnostics.
6. Export CSV if needed.

## Privacy

- Student data stays in `chrome.storage.local` on the browser profile where the extension is installed.
- The extension does not store Google passwords.
- The extension does not send Khan data to a remote server.
- The extension only requests access to Khan Academy pages.

## Status

This is a capture proof of concept. The main goal is to reliably read the visible Khan Activity Report, including reports rendered inside Khan's embedded frames.
