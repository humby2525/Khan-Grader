# Chrome Web Store Submission

Use this document when creating the unlisted Chrome Web Store item.

## Product details

**Name**

Khan Grader

**Summary**

Capture Khan Academy activity minutes and send teacher-reviewed grades to Schoology.

**Category**

Education

**Detailed description**

Khan Grader helps teachers turn Khan Academy activity minutes into reviewed Schoology grades.

Teachers can:

- Select a weekly date range.
- Capture exercise minutes and time on task for saved Khan Academy classes.
- Set a different minute goal for each class.
- Review student matches and calculated grades before sending anything.
- Reuse an existing Schoology assignment or create a missing weekly assignment.
- Send approved grades to Schoology for an existing Schoology-to-SIS workflow.

Khan Grader uses the teacher's existing signed-in Khan Academy session and does not store a Khan or Google password. Schoology credentials and student results are stored locally in the teacher's Chrome profile. The extension has no developer-operated data server and does not use advertising or analytics.

## Single purpose

Help teachers capture Khan Academy activity minutes and transfer teacher-reviewed assignment grades to Schoology.

## Permission justifications

**activeTab**

Allows a teacher-initiated action to inspect the active Khan Academy or Schoology page when using current-page capture and setup tools.

**scripting**

Runs packaged capture code in Khan Academy pages to read the class roster and request the selected activity report, and in a teacher-opened Schoology assignment page to read category and grading-period dropdown choices. No remote code is executed.

**storage**

Stores class settings, Schoology API settings, and the latest captured results locally in the teacher's Chrome profile.

**tabs**

Finds an already-open Khan or Schoology tab and temporarily opens each saved Khan class roster page during a teacher-initiated multi-class capture.

**webRequest**

Supports the teacher-initiated Khan network diagnostic tool by recording the URL and request-body shape of Khan report requests while the diagnostic is active. The diagnostic is off by default and its results remain in the extension session.

**Host access: khanacademy.org and subdomains**

Required to read teacher-authorized Khan class rosters and activity reports using the teacher's existing signed-in browser session.

**Host access: schoology.com and subdomains**

Required only for the teacher-initiated setup tool that reads assignment dropdown choices from an open Schoology page.

**Host access: api.schoology.com**

Required to load Schoology sections and enrollments, find or create weekly assignments, and send grades after teacher review and confirmation.

## Remote code

Select **No, I am not using remote code**. All executable JavaScript is included in the extension package. Khan Academy and Schoology return data, not code that the extension executes.

## Data-use disclosure

Disclose these categories in the Privacy practices tab when the dashboard presents them:

- Personally identifiable information: student names and platform identifiers.
- Authentication information: teacher-entered Schoology API consumer key and secret, plus use of the existing Khan browser session.
- Website content: Khan reports, rosters, and Schoology assignment-page dropdown values.
- Web browsing activity: Khan and Schoology URLs needed to identify the active class or assignment page and Khan request metadata captured only during the optional diagnostic.

The data is used for the extension's single purpose. It is stored locally and sent only to Khan Academy or Schoology to complete actions initiated by the teacher. It is not sold, used for advertising, transferred to data brokers, or used for lending or credit purposes.

## Privacy policy URL

After enabling GitHub Pages from the repository's `docs` folder, use:

`https://humby2525.github.io/Khan-Grader/privacy.html`

Open the URL in a signed-out browser window before submitting it to confirm it is public.

## Reviewer instructions

Khan Grader is a teacher workflow extension that requires authorized Khan Academy and Schoology teacher accounts. No credentials are included in the extension.

1. Install the extension and click its toolbar icon. The full extension dashboard opens in a Chrome extension tab.
2. In Setup, a teacher can save Khan class roster URLs and Schoology API settings. These values remain in local extension storage.
3. The main workflow is Prepare Assignments, Capture Minutes, Review Grades, and Send Grades.
4. Khan capture requires the browser to already be signed in to an authorized Khan Academy teacher account. It reads the roster and activity report only after the teacher clicks Capture Minutes.
5. Schoology actions require a teacher-provided Schoology API consumer key and secret. Sending grades requires a preview followed by an explicit confirmation.
6. The Start Network Probe tool is an optional diagnostic. It records Khan request metadata only after the teacher starts it.

If the review team requires live access to protected features, provide dedicated test teacher accounts with synthetic student data. Do not provide personal accounts or real student records.

## Distribution

Choose **Unlisted**. The extension will not appear in Chrome Web Store search, but anyone with its store URL can install it unless their browser administrator blocks it.

## Required listing assets

- Store icon: `icons/icon-128.png`
- Dashboard screenshot: `store-assets/dashboard-1280x800.png`
- Small promotional image: `store-assets/small-promo-440x280.png`

Keep real student names, API credentials, section IDs, and other school data out of listing screenshots.
