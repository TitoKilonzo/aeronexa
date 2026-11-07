FROM node:22-alpine AS build
WORKDIR /workspace
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/
COPY packages/shared/package*.json ./packages/shared/
RUN npm install --workspaces --include-workspace-root
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
RUN npm run build --workspace @aeronexa/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/package.json ./package.json
COPY --from=build /workspace/apps/api/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]
