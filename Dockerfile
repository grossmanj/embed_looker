FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

EXPOSE 8080

CMD ["node", "src/server.js"]
