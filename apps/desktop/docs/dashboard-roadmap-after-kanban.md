# Career-Ops React Dashboard Upgrade Spec

## Goal

Turn the dashboard into a CRM-style job search command center.

The main screen should be a kanban board where each job is a movable card. Scanning and evaluation should live in a separate Discovery/Automation tab. The main product question should be:

> What should Nolan do next?

## Product Principle

The dashboard should be a CRM first.

Scanning and AI evaluation feed the CRM, but the core experience should be:

```text
Review card
Prepare materials
Generate autofill prompt
Apply manually with browser agent
Move card to next stage
Track follow-up
```

## Recommended Build Order

1. Build kanban CRM board with counters.
2. Add drag-and-drop status updates.
3. Persist status changes.
4. Add support for `Online Assessment`.
5. Add card detail drawer.
6. Add cover letter PDF export.
7. Add autofill prompt generation.
8. Add Discovery tab for scan/evaluation.
9. Add daily scan status.
10. Add analytics/follow-up widgets.
11. Add settings/targeting editor.

---

## Task 1: CRM Kanban Board

### Goal

Create the main dashboard view as a CRM-style kanban board for job applications.

The board should let Nolan see applications grouped by status and move cards between statuses with drag-and-drop.

Do not implement scanning, evaluation, cover-letter PDF export, or autofill prompt generation in this first slice. This task is only the CRM board.

### Recommended Library

Use `dnd-kit` for drag-and-drop.

The board needs multiple sortable lists:

```text
Cards can move within a column
Cards can move across columns
Counters update immediately
```

### Columns

Create these columns:

```text
Need to Apply
Applied
Online Assessment
Interview
Offer
Rejected / Archived
```

Each column should show a counter:

```text
Need to Apply 12
Applied 5
Online Assessment 2
Interview 1
Offer 0
Rejected / Archived 8
```

### Status Model

Use this frontend status model:

```ts
export type CRMStatus =
  | "need_to_apply"
  | "applied"
  | "online_assessment"
  | "interview"
  | "offer"
  | "rejected_archived";
```

Create:

```text
src/features/crm/statusConfig.ts
```

```ts
export const CRM_COLUMNS = [
  {
    id: "need_to_apply",
    label: "Need to Apply",
  },
  {
    id: "applied",
    label: "Applied",
  },
  {
    id: "online_assessment",
    label: "Online Assessment",
  },
  {
    id: "interview",
    label: "Interview",
  },
  {
    id: "offer",
    label: "Offer",
  },
  {
    id: "rejected_archived",
    label: "Rejected / Archived",
  },
] as const;
```

Map existing career-ops statuses to CRM statuses:

```ts
export function mapCareerOpsStatusToCRM(status: string): CRMStatus {
  const normalized = status.toLowerCase().trim();

  if (normalized.includes("online assessment") || normalized === "oa") {
    return "online_assessment";
  }

  if (normalized.includes("applied")) {
    return "applied";
  }

  if (normalized.includes("interview")) {
    return "interview";
  }

  if (normalized.includes("offer")) {
    return "offer";
  }

  if (
    normalized.includes("rejected") ||
    normalized.includes("discarded") ||
    normalized.includes("skip") ||
    normalized.includes("archived")
  ) {
    return "rejected_archived";
  }

  return "need_to_apply";
}
```

For now, `Evaluated` should map to `Need to Apply`.

### Application Card Type

Create or adapt:

```ts
export type ApplicationCard = {
  id: string;
  number: number;
  company: string;
  role: string;
  score: number | null;
  status: CRMStatus;

  jobUrl?: string;
  reportPath?: string;
  pdfPath?: string;

  coverLetterPath?: string;
  coverLetterPdfPath?: string;
  hasCoverLetterPdf?: boolean;

  applyPromptPath?: string;

  location?: string;
  workMode?: "remote" | "hybrid" | "onsite";
  payRange?: string;

  notes?: string;
  lastUpdated?: string;
  lastContact?: string;

  nextAction?: string;
};
```

### Card UI

Each card should display:

```text
Company
Role
Score badge
Location or work mode if available
Resume/PDF status if available
Next action if available
```

Example:

```text
Cloudflare
Data Science Intern
4.2/5
Austin - Hybrid
Resume missing
Next: Generate resume
```

Badges:

```text
Score >= 4.5: strong green badge
Score 4.0-4.4: green badge
Score 3.5-3.9: yellow badge
Score < 3.5: muted/red badge
```

### Layout Requirements

The board should be horizontally scrollable on smaller screens.

Each column should have:

```text
Fixed minimum width around 280-320px
Column header
Count badge
Scrollable card list
Empty state
```

Empty state:

```text
No applications
```

Cards should be:

```text
Compact
CRM-like
Scannable
Not oversized
Not marketing-card style
```

### Drag-and-Drop Behavior

Required behavior:

1. Drag card within same column to reorder.
2. Drag card to another column.
3. When dropped into another column, update the card status in local UI state.
4. Show visual dragged-card state or drag overlay.
5. Keep counters updated immediately.

Persistence can be a stub in the first pass:

```ts
async function updateApplicationStatus(
  applicationId: string,
  status: CRMStatus
) {
  // TODO: wire to backend/file update in persistence task
}
```

### Components To Build

```text
src/features/crm/CRMBoard.tsx
src/features/crm/CRMColumn.tsx
src/features/crm/ApplicationCard.tsx
src/features/crm/statusConfig.ts
src/features/crm/types.ts
```

Optional:

```text
src/features/crm/useKanbanState.ts
```

### CRMBoard Responsibilities

```text
Accept applications as props
Group cards by CRM status
Render columns
Handle drag start / drag over / drag end
Update card status when moved across columns
Update card order when moved within a column
Keep column counters correct
```

Expected props:

```ts
type CRMBoardProps = {
  applications: ApplicationCard[];
  onStatusChange?: (applicationId: string, status: CRMStatus) => Promise<void>;
  onCardClick?: (application: ApplicationCard) => void;
};
```

### CRMColumn Responsibilities

```text
Render column title
Render count
Render sortable card list
Render empty state
Act as droppable area
```

Expected props:

```ts
type CRMColumnProps = {
  id: CRMStatus;
  title: string;
  cards: ApplicationCard[];
  onCardClick?: (application: ApplicationCard) => void;
};
```

### ApplicationCard Responsibilities

```text
Render compact card content
Show score badge
Show material/status badges
Be draggable/sortable
Call onClick when clicked
```

Do not put action buttons inside the card yet. Card actions should come through the detail drawer.

### Acceptance Criteria

The CRM board task is done when:

1. The app displays a kanban board with the six columns.
2. Each column shows the correct counter.
3. Application cards render in the correct columns.
4. Cards can be dragged within a column.
5. Cards can be dragged to another column.
6. Moving a card updates visible status and counters.
7. Card click handler is wired but can call a placeholder.
8. No scanning/evaluation/cover-letter/autofill functionality is added yet.
9. UI is clean, compact, and CRM-like.

---

## Task 2: Persist Status Changes

### Goal

When a card moves between CRM columns, save that status change to the career-ops data source instead of only updating local React state.

### Persisted Status Mapping

Persist UI statuses to career-ops statuses:

```ts
need_to_apply -> Evaluated
applied -> Applied
online_assessment -> Online Assessment
interview -> Interview
offer -> Offer
rejected_archived -> Discarded
```

### Backend/API Work

Add an action:

```ts
updateApplicationStatus(applicationId: string, status: CRMStatus)
```

It should update the correct row in:

```text
data/applications.md
```

### Career-Ops File Updates

Add `Online Assessment` as a canonical status in:

```text
templates/states.yml
normalize-statuses.mjs
verify-pipeline.mjs
merge-tracker.mjs
dedup-tracker.mjs if needed
```

### Acceptance Criteria

1. Moving a card updates the UI immediately.
2. Refreshing the app keeps the new status.
3. `node verify-pipeline.mjs` passes.
4. Existing statuses still load correctly.
5. Failed persistence rolls the UI back or shows an error.

---

## Task 3: Card Detail Drawer

### Goal

Clicking a card opens a right-side detail drawer with all job/application context and next actions.

### Drawer Sections

```text
Overview
Report Summary
Application Materials
Automation
Notes
Status
```

### Overview Fields

```text
Company
Role
Score
Status
Job URL
Location
Work mode
Pay range
Last updated
Next action
```

### Actions

```text
Open job posting
Open report
Open tailored resume PDF
Open cover letter
Save cover letter as PDF
Open cover letter PDF
Generate autofill prompt
Move to Applied
Move to Online Assessment
Move to Interview
Archive
```

Do not add a generate-cover-letter button because that already exists elsewhere.

### Acceptance Criteria

1. Clicking a card opens the drawer.
2. Drawer can be closed with Escape and close button.
3. Drawer shows report/material availability.
4. Drawer actions can be placeholders except file/URL open actions if already supported.

---

## Task 4: Cover Letter PDF Export

### Goal

Allow an already-generated cover letter to be saved as a PDF.

### Button

```text
Save Cover Letter as PDF
```

### Input

Use the existing cover letter markdown/content. Do not regenerate the cover letter.

### Output

Save PDF to:

```text
output/cover-letters/{number}-{company-slug}-cover-letter.pdf
```

### State Fields

```ts
coverLetterPath?: string;
coverLetterPdfPath?: string;
hasCoverLetterPdf: boolean;
```

### UI States

```text
No cover letter generated
Cover letter ready
PDF missing
Exporting PDF
PDF ready
Export failed
```

### Button Logic

```ts
if (!coverLetterPath) {
  show "Cover letter not generated yet";
}

if (coverLetterPath && !coverLetterPdfPath) {
  show "Save Cover Letter as PDF";
}

if (coverLetterPdfPath) {
  show "Open Cover Letter PDF";
}
```

### Recommended Implementation

Use server-side PDF generation:

```text
Markdown cover letter -> HTML template -> Playwright/Puppeteer -> PDF
```

### PDF Requirements

```text
One page if possible
ATS-safe selectable text
Simple header with Nolan's contact info
Company and role-specific title
Readable margins
No decorative layout
```

### Acceptance Criteria

1. Button is hidden/disabled if no cover letter exists.
2. Clicking it creates a PDF.
3. The app shows `Open PDF` after export.
4. Generated path is stored on the application model.
5. PDF export does not overwrite the markdown cover letter.

---

## Task 5: Autofill Prompt Generation

### Goal

Generate a browser-agent prompt that Nolan can paste into Gemini, Codex Computer Use, or another browser-control agent to autofill an application.

### Output File

```text
output/apply-prompts/{number}-{company-slug}-autofill-prompt.md
```

### Prompt Must Include

```text
Job URL
Company
Role
Candidate info
Resume PDF path
Cover letter path
Cover letter PDF path if available
LinkedIn
Portfolio
School
Major
Graduation date
Work authorization
Report-based talking points
Common short answers
```

### Required Safety Instruction

```text
Fill out the application and upload materials if needed, but stop before clicking Submit. Ask Nolan to review everything manually.
```

### Prompt Template

```markdown
You are helping Nolan Wu apply to this role.

Company: {company}
Role: {role}
Job URL: {jobUrl}

Candidate info:
Name: Nolan Wu
Email: nyw3@cornell.edu
Phone: +1-669-377-4521
School: Cornell University
Major: Operations Research Engineering
Graduation: May 2028
Work authorization: US citizen, no sponsorship required
LinkedIn: {linkedin}
Portfolio: {portfolio}

Files:
Resume PDF: {resumePdfPath}
Cover Letter: {coverLetterPath}
Cover Letter PDF: {coverLetterPdfPath}

Instructions:
1. Open the job URL.
2. Fill in all application fields using the candidate info.
3. Upload the resume PDF.
4. Upload the cover letter PDF if the form asks for one.
5. Draft short-answer responses using the report notes below.
6. Stop before clicking Submit.
7. Ask Nolan to review the full application manually.

Do not submit the application.

Report notes:
{reportSummary}
```

If no cover letter PDF exists, fall back to the markdown cover letter path.

### Acceptance Criteria

1. Drawer has `Generate Autofill Prompt`.
2. Generated prompt can be previewed.
3. Prompt path is saved to the card/application model.
4. Prompt references the cover letter PDF when available.
5. Prompt falls back to markdown cover letter when PDF is missing.
6. Prompt always includes the no-submit safety instruction.

---

## Task 6: Discovery Tab

### Goal

Move scanning and evaluation out of the main CRM workflow into a separate Discovery tab.

### Sections

```text
Daily Scan Status
New Jobs Found
Pending Evaluation Queue
Recently Evaluated
Expired / Duplicate / Skipped Jobs
```

### Data Sources

```text
data/pipeline.md
data/scan-history.tsv
portals.yml
reports/
```

### Actions

```text
Run scan now
Evaluate selected job
Evaluate all high-confidence jobs
Open scanner settings
Edit target role keywords
```

### Acceptance Criteria

1. Discovery tab shows pending jobs from `data/pipeline.md`.
2. It shows recent scan history from `data/scan-history.tsv`.
3. It separates added, duplicate, expired, and title-skipped jobs.
4. It can trigger scan/evaluation actions through backend stubs if full automation is not ready.
5. Discovery tab is secondary to the CRM board.

---

## Task 7: Daily Scan Automation Status

### Goal

Show whether the daily scanner is running and what happened during the latest scan.

### UI Fields

```text
Last scan time
New jobs found
Pending evaluation count
Expired skipped
Duplicates skipped
Title skipped
Scan errors
```

### Implementation Options

```text
Windows Task Scheduler
Node cron process
Backend scheduled job
Manual "Run scan now" only for first version
```

### Acceptance Criteria

1. Dashboard shows latest scan summary.
2. Dashboard can tell when no scan has run yet.
3. Manual scan trigger is available even if daily automation is not configured.
4. Scan status does not block normal CRM usage.

---

## Task 8: Analytics Tab

### Goal

Add a secondary analytics tab for job-search performance.

### Widgets

```text
Applications by status
Average score
Top-scoring companies
Score distribution
Response rate
Interview rate
Applications per week
High-score jobs not yet applied
Applied jobs needing follow-up
Online assessments pending
```

### Acceptance Criteria

1. Analytics are read-only.
2. Metrics update when application status changes.
3. High-score not-applied jobs are easy to identify.
4. Analytics remain secondary to the CRM workflow.

---

## Task 9: Follow-Up Queue

### Goal

Create a queue that surfaces applications requiring action.

### Rules

```ts
if (status === "applied" && daysSinceLastContact > 7) {
  return "Follow up";
}

if (status === "online_assessment") {
  return "Complete assessment";
}

if (status === "interview") {
  return "Prepare interview";
}

if (status === "need_to_apply" && score >= 4.0) {
  return "Apply soon";
}
```

### Queue Buckets

```text
Apply Soon
Follow Up
Online Assessment
Interview Prep
Stale / Needs Review
```

### Acceptance Criteria

1. Follow-up queue appears in analytics or its own tab.
2. Queue links back to the application card/detail drawer.
3. Rules are centralized and easy to adjust.
4. Queue is sorted by urgency.

---

## Task 10: Settings / Targeting Editor

### Goal

Make it easier to update job-search targeting from the UI.

### Editable Files

```text
config/profile.yml
portals.yml
modes/_profile.md eventually, but not first
```

### First Editable Settings

```text
Target role keywords
Negative keywords
Enabled portals/search queries
Tracked companies enabled/disabled
Location preferences
Compensation target
```

### Acceptance Criteria

1. Settings editor validates YAML before saving.
2. Broken settings cannot be saved.
3. User can disable noisy queries/companies.
4. User can add new positive/negative title keywords.
5. Settings changes are reflected in the Discovery tab.

---

## Backend/API Expectations

The React app should expose or call backend actions like:

```ts
getApplications()
updateApplicationStatus(id, status)
getApplicationReport(id)
getPipelineJobs()
getScanHistory()
runScan()
runEvaluation(jobId)
exportCoverLetterPdf(applicationId)
generateAutofillPrompt(applicationId)
openFile(path)
openUrl(url)
```

## Data Sources

Use existing career-ops files:

```text
cv.md
config/profile.yml
modes/_profile.md
data/applications.md
data/pipeline.md
data/scan-history.tsv
reports/
output/
output/cover-letters/
output/apply-prompts/
portals.yml
```

## Out Of Scope

Do not automate final application submission.

Any browser-agent workflow must stop before clicking:

```text
Submit
Send
Apply
```

Nolan must review applications manually before submission.
