FROM node:lts
RUN apt update && DEBIAN_FRONTEND=noninteractive apt install -y python3 python3-pip && rm -rf /var/lib/apt/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Clean build
FROM node:lts
VOLUME [ "/data" ]
WORKDIR /app
COPY --from=0 /app/ ./
RUN npm link
ENTRYPOINT [ "apt-stream", "server", "--data", "/data" ]
