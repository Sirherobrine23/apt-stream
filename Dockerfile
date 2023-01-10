FROM node:latest
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENTRYPOINT [ "node", "src/index.js", "server" ]