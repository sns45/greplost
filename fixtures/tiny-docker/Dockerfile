# tiny-docker: the smallest repo that exercises every Dockerfile rule (build 2, leaf 2.10).
ARG NODE_VERSION=20

FROM node:20 AS build
ENV NODE_ENV=production
WORKDIR /app
COPY package.json .
COPY app/server.ts ./app/server.ts
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs20 AS run
COPY --from=build /app /app
ENV PORT=8080
ENTRYPOINT ["/nodejs/bin/node", "/app/server.js"]
CMD ["--enable-source-maps"]
