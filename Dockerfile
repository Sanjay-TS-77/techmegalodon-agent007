FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4387 \
    AGENT007_DATA_DIR=/var/lib/agent007

RUN install -d -o node -g node /var/lib/agent007
COPY package.json LICENSE ./
COPY src/ ./src/
COPY public/ ./public/
COPY examples/ ./examples/

USER node
EXPOSE 4387
VOLUME ["/var/lib/agent007"]
CMD ["node", "src/server.mjs"]
