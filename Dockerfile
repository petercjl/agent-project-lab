FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DATA_DIR=/app/data
EXPOSE 4317
CMD ["npm", "start"]
