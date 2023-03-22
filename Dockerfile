FROM node:lts
RUN apt update && DEBIAN_FRONTEND=noninteractive apt install -y python3 python3-pip && rm -rf /var/lib/apt/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Clean build
FROM node:lts
VOLUME [ "/data" ]
COPY --from=0 /app/ /app
WORKDIR /app
RUN npm link
ENTRYPOINT "apt-stream server --cache /data/cache --data /data/data"