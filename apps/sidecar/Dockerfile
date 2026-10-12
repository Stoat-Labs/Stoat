FROM golang:1.26.1-alpine AS build

WORKDIR /src/stoat/sidecar

COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY . .
RUN go test ./...
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /out/sidecar ./cmd/sidecar


# DB-IP's IP to Country Lite (CC BY 4.0, https://db-ip.com), for Alloy's visitor-by-country
# metrics. A new month's file can be missing for its first days, so fall back to the previous one.
FROM alpine:3.23.3 AS geoip

ARG USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

RUN apk --no-cache add curl \
    && year=$(date -u +%Y) month=$(date -u +%m | sed 's/^0//') \
    && if [ "$month" = 1 ]; then previous="$((year - 1))-12"; else previous=$(printf '%d-%02d' "$year" "$((month - 1))"); fi \
    && for edition in "$(printf '%d-%02d' "$year" "$month")" "$previous"; do \
        curl -fsSL --retry 3 -A "$USER_AGENT" -o /country.mmdb.gz \
            "https://download.db-ip.com/free/dbip-country-lite-$edition.mmdb.gz" && break; \
    done \
    && gunzip /country.mmdb.gz


FROM alpine:3.23.3

RUN apk --no-cache add ca-certificates util-linux \
    && addgroup -S sidecar \
    && adduser -S -G sidecar sidecar

COPY --from=build --chown=sidecar:sidecar /out/sidecar /usr/local/bin/sidecar
COPY --from=geoip /country.mmdb /usr/share/stoat/geoip/country.mmdb

EXPOSE 80

USER sidecar

# Auto-detect /run/uncloud/api/uncloud.sock (current) or /run/uncloud/uncloud.sock (legacy).
ENTRYPOINT ["/usr/local/bin/sidecar"]
# /host is the host root mount from docker-compose.yml; Alloy bind-mounts /var/lib/stoat/geoip.
CMD ["--listen", "0.0.0.0:80", "--geoip-dir", "/host/var/lib/stoat/geoip"]
