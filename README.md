# UM Pathfinder

Helps University of Montana students explore courses from any college that fit their majors, interests, minors, certificates and career goals.

## Run it

```bash
node server.js
```

Run this from the project folder, then open http://localhost:5600. You need Node 18 or newer. There are no packages to install.

The server starts from the catalog copy saved in `data/catalog.json`. It re-checks catalog.umt.edu whenever that copy is more than 7 days old (you can change this with `CATALOG_MAX_AGE_DAYS`). Students can also click **Check catalog for updates**, which can run at most once an hour.

## Hosting: GitHub Pages + Render

The web page and the catalog server are hosted separately:

| Part | Host | Address |
|---|---|---|
| Web page (`public/`) | GitHub Pages, published by `.github/workflows/pages.yml` | https://michaelcassens.github.io/InterestDiscovery/ |
| Catalog API (`server.js`) | Render free web service, set up by `render.yaml` | https://um-pathfinder.onrender.com |

- `public/config.js` tells the page where the API is. If your Render service gets a different address, change it there.
- The server only accepts requests from the pages listed in `ALLOWED_ORIGINS`, which is set in `render.yaml`.
- Every Monday, `.github/workflows/refresh-catalog.yml` re-reads the catalog and commits a fresh `data/catalog.json`.
- Render is connected to this GitHub repo and redeploys automatically on every commit to `main`, including the weekly catalog commit. The server doesn't depend on redeploys for fresh data: when its copy is more than 7 days old, it keeps serving that copy and re-reads catalog.umt.edu in the background.
- Render's free plan puts the server to sleep after 15 minutes without visitors. The first visitor after that waits about a minute, and the page shows a "waking up" message while they wait.

**Updating from the parent `Claude Code Projects` folder:** the weekly job commits to GitHub, so pull its changes in before you push yours:

```bash
git subtree pull --prefix=um_pathfinder origin main -m "Merge catalog updates"
```
```bash
git subtree push --prefix=um_pathfinder origin main
```

## How it works

| Piece | What it does |
|---|---|
| `catalog.js` | Crawls every subject on `/courses/` and every undergraduate program page under `/colleges-schools-programs/`. It reads each course's title, credits, description, prerequisites, Gen Ed attributes and terms offered, plus each program's requirement groups and total credits. It saves them to `data/catalog.json`. |
| `server.js` | Serves the app and the cached catalog, and refreshes the cache in the background. |
| `public/app.js` | Does all matching in the browser, so no student data leaves the device. |
| `public/transcript.js` | Reads an unofficial transcript (PDF, saved web page, text, or pasted text) in the browser and finds each course's subject and number, title, grade and credits. It sorts courses into UM, in progress, and other schools (transfer, AP, dual credit). PDFs are read with pdf.js, which loads from cdnjs only when a student picks a PDF. The transcript itself is never uploaded or stored. |
| `public/knowledge.js` | Holds the hand-written layer: skill areas, learning outcomes, careers, hybrid "combination" roles, interest synonyms and the case for interdisciplinary study. **Faculty and advisors should edit this file.** |

### Suggestion score

- **Interest match:** interests are matched against course titles and descriptions. Rare words count more than common ones, and synonyms are included. Courses that match more than one interest get a bonus.
- **Course history:** the courses a student has taken are compared with the rest of the catalog by text similarity. The app also flags "next step" courses, meaning courses whose prerequisites the student has just met.
- **Fit:** a course gets a boost if it counts toward one of the student's programs, adds to a minor or certificate they've already started, or is a **possible substitution**. A possible substitution is a course from another department that closely resembles an elective group in their major. Students are always told to confirm these with an advisor.
- **Prerequisites:** each prerequisite is checked against the courses the student entered. Requirements like "consent of instructor" or "junior standing" are marked "needs a check" because the app can't verify them.

### Transcripts and transfer courses

- Students review every course before it's added. Courses with grades that usually earn no credit (F, W, NC and similar) start unchecked.
- Courses from other schools go under **Transfer & other courses**. Students match each one to a UM equivalent or leave it as "no direct equivalent". Pathfinder suggests matches in this order:
  1. the same course number at UM, since Montana's public colleges share common course numbers;
  2. the same number in a related UM subject (for example ENGL 101 → WRIT 101), using the `transferSubjects` table in `knowledge.js`;
  3. UM courses with similar titles at a similar level.
- A transfer course with a UM equivalent counts like that UM course for prerequisites, requirements, minors and careers.
- The Registrar decides official transfer credit, and the app says so wherever students choose equivalents.

## Known limits

- Requirement rules such as "choose 2 of" are shown but not fully enforced, so progress numbers are approximate. The degree audit is still the official record.
- The catalog doesn't publish program learning outcomes, so the outcomes shown come from `knowledge.js`.
- Transcript reading was tested on a real UM unofficial transcript PDF from Banner (85 courses, including AP credit, repeats and courses from the 1990s) and on sample transcripts. UM courses that aren't in today's catalog are listed as **older UM course numbers**, so students can match them to current courses. Pathfinder only pre-selects a match when the titles clearly agree. Scanned images can't be read, because there's no OCR.
- Job links open live searches on LinkedIn, Indeed, USAJOBS and O*NET. The app does not scrape LinkedIn, because that breaks LinkedIn's terms and requires a login.
