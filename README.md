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

Scoring (edit the constants at the top of `api/portal.mjs`; keep the matching ones in `src/App.jsx`):
- Reading: 1 point per active minute, max 100 per book (time counts only while the reader is open and the tab is visible; "Still reading?" every 10 min; max 3 h per book per day)
- Finished book: 1,000 (needs 30 min reading + 10 written answers)
- 10 answers: 1,000 (each at least 80 characters; near-copies rejected; admins can reject answers)
- Total = reading + finished + answers
