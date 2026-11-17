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
- Every Monday, `.github/workflows/refresh-catalog.yml` re-reads the catalog and commits a fresh `data/catalog.json`. Render redeploys automatically when that happens.
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
| `public/knowledge.js` | Holds the hand-written layer: skill areas, learning outcomes, careers, hybrid "combination" roles, interest synonyms and the case for interdisciplinary study. **Faculty and advisors should edit this file.** |

### Suggestion score

- **Interest match:** interests are matched against course titles and descriptions. Rare words count more than common ones, and synonyms are included. Courses that match more than one interest get a bonus.
- **Course history:** the courses a student has taken are compared with the rest of the catalog by text similarity. The app also flags "next step" courses, meaning courses whose prerequisites the student has just met.
- **Fit:** a course gets a boost if it counts toward one of the student's programs, adds to a minor or certificate they've already started, or is a **possible substitution**. A possible substitution is a course from another department that closely resembles an elective group in their major. Students are always told to confirm these with an advisor.
- **Prerequisites:** each prerequisite is checked against the courses the student entered. Requirements like "consent of instructor" or "junior standing" are marked "needs a check" because the app can't verify them.

## Known limits

- Requirement rules such as "choose 2 of" are shown but not fully enforced, so progress numbers are approximate. The degree audit is still the official record.
- The catalog doesn't publish program learning outcomes, so the outcomes shown come from `knowledge.js`.
- Job links open live searches on LinkedIn, Indeed, USAJOBS and O*NET. The app does not scrape LinkedIn, because that breaks LinkedIn's terms and requires a login.
