#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 24 )); then
  echo "AtomJS requires Node.js 24 or newer (found $(node --version))." >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "The repository must be on a named branch." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Git remote 'origin' is required." >&2
  exit 1
fi

echo "Syncing package versions..."
npm run sync:version

echo "Running tests and compatibility checks..."
npm test
npm run verify:electron
npm run pack:dry

VERSION="$(node -p "require('./package.json').version")"
NPM_TAG="${NPM_TAG:-alpha}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-chore: release v${VERSION}}"

echo "Checking npm authentication..."
npm whoami >/dev/null

for PACKAGE_NAME in \
  @atom-js-org/runtime \
  @atom-js-org/electron \
  @atom-js-org/cli; do
  if npm view "${PACKAGE_NAME}@${VERSION}" version >/dev/null 2>&1; then
    echo "${PACKAGE_NAME}@${VERSION} is already published; refusing to publish a duplicate." >&2
    exit 1
  fi
done

git add -A
if git diff --cached --quiet; then
  echo "No new Git changes to commit."
else
  git commit -m "$COMMIT_MESSAGE"
fi

echo "Pushing ${BRANCH} to GitHub..."
git push origin "$BRANCH"

echo "Publishing AtomJS ${VERSION} to npm with tag '${NPM_TAG}'..."
npm publish ./packages/atomjs --access public --tag "$NPM_TAG"
npm publish ./packages/electron-compat --access public --tag "$NPM_TAG"
npm publish ./packages/cli --access public --tag "$NPM_TAG"

echo "AtomJS ${VERSION} was pushed to GitHub and published to npm."
