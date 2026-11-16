FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY migrations migrations
COPY src src
# Cache mounts keep the registry and target dir between builds; the binary is copied out of the mount.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked && cp target/release/shuttlecircle /shuttlecircle

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 app && mkdir -p /media && chown app /media
COPY --from=build /shuttlecircle /usr/local/bin/shuttlecircle
USER app
EXPOSE 8080
CMD ["shuttlecircle"]
