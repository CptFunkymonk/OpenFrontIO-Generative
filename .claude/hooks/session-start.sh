#!/bin/bash
# SessionStart hook for Claude Code on the web. Provisions the toolchain CI
# uses (Node 24, npm 12.1.0), the project's dependencies, and the Playwright
# build that drives the environment's pre-installed headless Chromium.
# Idempotent: every step is skipped when already done, so a cached container
# starts in about a second.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

NODE_VERSION="24.21.0"
NPM_VERSION="12.1.0" # CI and the Dockerfile pin this exact version
# Must match the Chromium revision in $PLAYWRIGHT_BROWSERS_PATH
# (/opt/pw-browsers ships chromium-1194, which is Playwright 1.56.x).
PLAYWRIGHT_VERSION="1.56.1"
NODE_DIR="/opt/node24"

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# 1. Node 24 (package.json engines + engine-strict reject the image's Node 22).
if [ "$("$NODE_DIR/bin/node" --version 2> /dev/null || true)" != "v$NODE_VERSION" ]; then
    echo "session-start: installing Node $NODE_VERSION"
    tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
    tmp="$(mktemp -d)"
    curl -sSfL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$tmp/$tarball"
    (cd "$tmp" && curl -sSfL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" \
        | grep " $tarball\$" | sha256sum -c - > /dev/null)
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xJf "$tmp/$tarball" -C "$NODE_DIR" --strip-components=1
    rm -rf "$tmp"
fi
export PATH="$NODE_DIR/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$NODE_DIR/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# 2. npm 12. Installed from outside the repo, like the Dockerfile does
#    (before .npmrc is copied): the project's install policy governs its
#    dependencies, not the package manager itself.
if [ "$(npm --version)" != "$NPM_VERSION" ]; then
    echo "session-start: installing npm $NPM_VERSION"
    (cd / && npm install --global --ignore-scripts "npm@$NPM_VERSION" > /dev/null)
fi

# 3. Dependencies, via the repo's blessed `npm run inst` (npm ci), only when
#    package-lock.json or the Node version changed since the last install.
stamp="node_modules/.session-start-stamp"
want="$(sha256sum package-lock.json | cut -d' ' -f1) node-$NODE_VERSION"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
    echo "session-start: installing dependencies"
    npm run inst > /dev/null
    echo "$want" > "$stamp"
fi

# 4. Playwright, for driving the real client (not a project dependency;
#    --no-save keeps package.json and the lockfile untouched).
have="$(node -p "require('./node_modules/playwright/package.json').version" 2> /dev/null || true)"
if [ "$have" != "$PLAYWRIGHT_VERSION" ]; then
    echo "session-start: installing playwright $PLAYWRIGHT_VERSION"
    npm install --no-save --ignore-scripts "playwright@$PLAYWRIGHT_VERSION" > /dev/null
fi

echo "session-start: node $(node --version), npm $(npm --version), dependencies ready"
