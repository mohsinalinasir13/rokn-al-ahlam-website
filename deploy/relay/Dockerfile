# Rokn Al Ahlam enquiry relay - production image.
# Build from the repository root:
#   docker build -f deploy/relay/Dockerfile -t rokn-relay:<tag> .
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# The shared schema is a .js file, so the nearest package.json must declare ES modules.
RUN echo '{"name":"rokn-relay","private":true,"type":"module"}' > package.json

# Only what the relay needs: no dependencies to install, no build step.
COPY server/enquiry-relay.mjs server/index.mjs ./server/
COPY src/enquirySchema.js ./src/

# Unprivileged user shipped with the base image (uid 1000).
USER node

ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787

# Healthy only when the process answers AND has its upstream URL + signing secret configured.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.configured?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
