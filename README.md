# Rokn Al Ahlam

Production website for Rokn Al Ahlam Real Estate.

## Deployment (Hostinger Node.js Web App)

- Build command: `npm run build`
- Production output: `dist`
- SPA fallback: `public/.htaccess` (Apache mod_rewrite, routes unknown paths to `dist/index.html`) is required for direct loads/refreshes on client-side routes to work on Hostinger's Web Apps hosting. Confirmed working 2026-09-16.

Forms currently provide client-side validation and a clear success acknowledgement. Wire a server-side email or form endpoint before go-live; do not place any credentials in the browser bundle.
