# Rokn Al Ahlam

Production website for Rokn Al Ahlam Real Estate.

## Deployment (Hostinger Node.js Web App)

- Build command: `npm run build`
- Production output: `dist`
- SPA fallback: `public/_redirects` is included. If the Hostinger Node.js service needs an explicit fallback, route all unknown paths to `dist/index.html`.

Forms currently provide client-side validation and a clear success acknowledgement. Wire a server-side email or form endpoint before go-live; do not place any credentials in the browser bundle.
