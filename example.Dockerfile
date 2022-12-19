FROM debian:latest
ARG DEBIAN_FRONTEND="noninteractive"
RUN apt update && apt install -y jq curl
WORKDIR /tmp/debs
RUN curl -Ssq https://api.github.com/repos/cli/cli/releases | grep "browser_download_url.*deb" | cut -d '"' -f 4 | xargs -n 1 curl -SsL -O

FROM scratch
COPY --from=0 /tmp/debs/*.deb /