# UM Pathfinder

Helps University of Montana students explore courses from any college that fit their majors, interests, minors, certificates and career goals.

## Run it

```bash
node server.js
```

Run this from the project folder, then open http://localhost:5600. You need Node 18 or newer. There are no packages to install.

The first time it runs, it downloads the catalog from catalog.umt.edu, which takes about 2 minutes. After that it re-checks the catalog whenever the copy is more than 7 days old (you can change this with `CATALOG_MAX_AGE_DAYS`). Students can also click **Check catalog for updates**.

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
