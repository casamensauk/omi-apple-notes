# node:sqlite is unflagged from Node 24, which keeps the relay dependency-free.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
# Queue and note mirror live on the Railway volume mounted at /data.
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
