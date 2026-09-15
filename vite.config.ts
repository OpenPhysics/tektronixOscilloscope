import { defineConfig } from 'vite';

// The deployed page lives at https://<org>.github.io/tektronixOscilloscope/, so
// every asset URL needs that prefix. Without `base` the built page 404s on Pages
// while working perfectly in `npm run dev` - a classic trap. Pages paths are
// case-sensitive, so this must match the repository name exactly.
//
// VITE_BASE carries the base path the Pages deploy reports, which keeps the site
// working if the repo is renamed or moved to a custom domain. It is ignored when
// empty - an empty value would otherwise silently fall back to the domain root
// and break every asset URL again.
const reported = process.env.VITE_BASE?.trim();
const base = reported ? (reported.endsWith('/') ? reported : `${reported}/`) : '/tektronixOscilloscope/';

export default defineConfig({
  base,
  build: { target: 'es2022', outDir: 'dist' },
});
