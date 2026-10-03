#!/usr/bin/env bash
# Stamps the build number into index.html and sw.js.
# Usage: ./stamp-version.sh <build-number>      (CI passes github.run_number)
set -euo pipefail
BUILD="${1:?usage: stamp-version.sh <build-number>}"
DATE="$(date -u +%Y-%m-%d)"

[[ "$BUILD" =~ ^[0-9]+$ ]] || { echo "build must be a number"; exit 1; }
grep -q "__SQ_BUILD__" index.html || { echo "index.html has no __SQ_BUILD__ token"; exit 1; }

sed -i "s/__SQ_BUILD__/${BUILD}/; s/__SQ_BUILD_DATE__/${DATE}/" index.html

# sw.js: browsers only fetch a new service worker when sw.js changes byte-for-byte,
# so we always (re)write a build line at the top. Also fills __SQ_BUILD__ if you use it
# in your cache name, e.g.  const CACHE = 'squevetrack-__SQ_BUILD__';
if [ -f sw.js ]; then
  sed -i '/^\/\/ sq-build:/d' sw.js
  sed -i "s/__SQ_BUILD__/${BUILD}/g" sw.js
  sed -i "1i // sq-build: ${BUILD} (${DATE})" sw.js
fi
echo "Stamped build ${BUILD} (${DATE})"
