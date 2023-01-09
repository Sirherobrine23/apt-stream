FROM node:latest
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_OPTIONS="--max_old_space_size=4096"
ENTRYPOINT [ "node", "src/index.js", "server" ]