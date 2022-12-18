FROM debian:latest
ARG DEBIAN_FRONTEND="noninteractive"
RUN apt update && \
  cd /tmp && mkdir debs && cd debs && \
  apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances curl wget | grep "^\w" | sort -u | xargs apt download

FROM scratch
COPY --from=0 /tmp/debs/*.deb /