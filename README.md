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
