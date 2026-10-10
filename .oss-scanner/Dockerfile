# OSS Scanner build image (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as the build context, then runs
# its audit offline, so every dependency the worker and its tests need is
# fetched here. Deno is pinned to .deno-version.
FROM denoland/deno:debian-2.9.6

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates bash git jq python3 \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src/worker/deno

# Fetch and type-check every module (including tests) against the lockfile,
# so the offline audit can run `deno task test` with a warm cache.
RUN deno install --frozen --lock=deno.lock \
    && deno task check

# Smoke-run a small slice of the suite; a failure warns rather than aborting
# the build. The full suite is `deno task test` from /src/worker/deno.
RUN (deno task test tests/acting_github_user_test.ts tests/add_repo_test.ts \
      || echo "WARNING: smoke tests reported failures")
