# syntax=docker/dockerfile:1
FROM node:lts-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 3004
CMD ["node", "server.js"]
