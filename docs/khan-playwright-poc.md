# Khan Playwright Proof of Concept

This proof of concept is Khan-only. It does not calculate grades and does not connect to Schoology or Infinite Campus.

## Goal

The first milestone is one-student capture from:

Reports -> Individual Student Report -> Activity log

The script opens Chrome with a persistent local profile, lets you log in normally, sets a custom Khan date range, inspects Khan JSON responses, and captures:

- Student name
- Exercise minutes
- Time on task minutes

## Run

```powershell
npm install
npm run capture:one -- --start 2026-08-17 --end 2026-08-23
```

Optional direct URL:

```powershell
npm run capture:one -- --url "https://classroom.khanacademy.org/" --start 2026-08-17 --end 2026-08-23
```

## Login

The script uses this local browser profile:

```text
.pw-khan-profile/
```

That folder is ignored by Git. It stores the normal Chrome login/session state created by the browser. The code does not store your Khan or Google username or password.

## Output

Captures are written locally to:

```text
captures/
```

That folder is ignored by Git because it may contain student data.

Each run writes:

- A `.csv` file with the one-student result.
- A `.json` file with diagnostics, frame text samples, and structured Khan JSON response candidates.

## Next Step

Do not build the full student loop until the one-student custom-date capture works reliably. Once this captures one student correctly, the next milestone is using the Switch Student control to move through the class.
