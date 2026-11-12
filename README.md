# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Shared database + scoring
1. Vercel -> Storage -> Create Database -> Upstash for Redis -> connect to this project.
2. Add the variables in `.env.example`, push to GitHub, let Vercel redeploy.
3. Register the two admin emails first (they need ADMIN_SETUP_CODE).
4. `api/portal.mjs` is the backend; `npm run dev` does not run it, so test on Vercel.

Scoring (constants at the top of `api/portal.mjs`; matching ones in `src/App.jsx`):
- A student appears on the leaderboard after 30 minutes of reading one book.
- Reading: 1 point per active minute, max 100 per book. Finished book: 1,000. 10 answers: 1,000.
- Passwords are stored hashed. Admins cannot read them; they can issue a temporary password instead.

Theme: dark/light colours are CSS variables in `index.html`. Logo files are in `public/`.
Covers: Admin -> Drive Sync -> "Generate missing covers" makes covers for books Drive has no thumbnail for.

## Analytics, catalog editor and sync log (admin only)
- **Admin -> Analytics:** daily/weekly/monthly active readers, hours read, completion rate, average time to finish and average quiz score per book and per subject. CSV export (opens in Excel) for engagement, books, categories, leaderboard and all students.
  After installing, press "Recount from student records" once so earlier reading is included (the daily charts start from the install day).
- **Admin -> Catalog Manager:** edit title, author, category, tags; pin books as Featured; mark books "Required" for cohorts (or ALL). Edits are saved in the portal (Redis); Google Drive files are not changed.
- **Admin -> Drive Sync:** new/removed books, unreadable files, broken links (and a "Check all links" tool), scan errors.
- **Cohort:** students enter their class/cohort at registration or in Account settings (key icon); admins can set it on the student profile. Students see "Required" badges for their cohort.
- **Quiz score:** staff give each student's answers a 0-10 score in the student profile; that feeds "Avg quiz score".

## Collections, professors, popularity, and uploading books
- **Catalog search bar:** "All Books" / "STEM Resources" / "CamTech Advisor" (replaces the PDF/EPUB filter).
  - STEM Resources = books in the main Drive library folder (not inside the CamTech Advisor folder). Only the "All" chip is shown.
  - CamTech Advisor = books inside the `CamTech Advisor` folder (one sub-folder per professor) + any book an admin tags with "recommended by". Chips: All + one per professor.
  - Books are listed most-viewed first (featured / required-for-you books are pinned above that).
- **Drive layout:** `<library folder>/CamTech Advisor/<Professor name>/book.pdf`. The folder name can be changed with VITE_ADVISOR_FOLDER_NAME.
- **Admin -> Upload Books:** uploads PDF/EPUB straight from the browser into Google Drive (STEM Resources, or CamTech Advisor > professor). One-time setup: create a Google OAuth *Web* client ID, add the site address under Authorized JavaScript origins, set VITE_GOOGLE_CLIENT_ID in Vercel. The admin who uploads signs in with Google and needs Editor access to the library folder.
