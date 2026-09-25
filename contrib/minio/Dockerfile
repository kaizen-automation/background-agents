# syntax=docker/dockerfile:1
# Official release images are no longer available. Build the same releases
# from checksum-verified upstream source instead of trusting a third-party mirror.
FROM golang:1.24.2-bookworm AS build-base
WORKDIR /src

# Archives omit .git, so supply the metadata from upstream gen-ldflags.go
# explicitly. Keep the release, commit and checksum pins together when upgrading.
FROM build-base AS server-build
ADD --checksum=sha256:1a63209927b9d1fb239b2a776b7b01d1902eff19379a108f4bc7005edcc0968c https://codeload.github.com/minio/minio/tar.gz/refs/tags/RELEASE.2025-04-22T22-12-26Z /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -buildvcs=false \
    -ldflags="-s -w -X github.com/minio/minio/cmd.Version=2025-04-22T22:12:26Z \
      -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-04-22T22-12-26Z \
      -X github.com/minio/minio/cmd.CommitID=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e \
      -X github.com/minio/minio/cmd.ShortCommitID=0d7408fc9969 \
      -X github.com/minio/minio/cmd.CopyrightYear=2025" \
    -o /out/minio .

FROM build-base AS client-build
ADD --checksum=sha256:526ec538e7f83e4bfa631788129b08ec85898ca572ce0523ebf9a597946bea27 https://codeload.github.com/minio/mc/tar.gz/refs/tags/RELEASE.2025-04-16T18-13-26Z /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -buildvcs=false \
    -ldflags="-s -w -X github.com/minio/mc/cmd.Version=2025-04-16T18:13:26Z \
      -X github.com/minio/mc/cmd.ReleaseTag=RELEASE.2025-04-16T18-13-26Z \
      -X github.com/minio/mc/cmd.CommitID=b00526b153a31b36767991a4f5ce2cced435ee8e \
      -X github.com/minio/mc/cmd.ShortCommitID=b00526b153a3 \
      -X github.com/minio/mc/cmd.CopyrightYear=2025" \
    -o /out/mc .

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

FROM runtime AS server
COPY --from=server-build /out/minio /usr/local/bin/minio
COPY --from=server-build /src/LICENSE /usr/share/doc/minio/LICENSE
ENTRYPOINT ["minio"]

FROM runtime AS client
COPY --from=client-build /out/mc /usr/local/bin/mc
COPY --from=client-build /src/LICENSE /usr/share/doc/mc/LICENSE
ENTRYPOINT ["mc"]
