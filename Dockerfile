FROM nodejs:latest
VOLUME [ "/data" ]
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
ENV NODE_OPTIONS="--max_old_space_size=4096"
ENTRYPOINT [ "node", "src/index.js", "--port", "3000", "--config-path", "/data/.apt_stream.yml" ]