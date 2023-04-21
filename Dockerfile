FROM node
RUN apt update && DEBIAN_FRONTEND=noninteractive apt install -y python3 python3-pip && rm -rf /var/lib/apt/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run prepack
RUN npm link
ENTRYPOINT [ "apt-stream", "server", "--data", "/data" ]