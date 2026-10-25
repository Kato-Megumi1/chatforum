FROM node:22-bookworm-slim
RUN node -e "const fs=require('fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('tls').rootCertificates.join('\n'))" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
    && mkdir -p /runner && chown node:node /runner
WORKDIR /runner
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund playwright-core@1.63.0
COPY worker.cjs ./worker.cjs
ENV NODE_ENV=production
USER node
ENTRYPOINT ["timeout", "--signal=KILL", "24s", "node", "/runner/worker.cjs"]
