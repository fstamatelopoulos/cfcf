#!/usr/bin/env bash
#
# Compile libsqlite3 from the official amalgamation with extension loading
# enabled. Output: a single .dylib / .so / .dll in <out-dir> that
# Database.setCustomSQLite() consumes at runtime (see
# packages/core/src/clio/db.ts). Without this, sqlite-vec can't be loaded
# on macOS — Apple's system SQLite is built with SQLITE_OMIT_LOAD_EXTENSION.
#
# Usage:  build-sqlite.sh <platform> <out-dir>
# Env override: SQLITE_VERSION (default 3530000 → SQLite 3.53.0).
#
# The version is pinned per cfcf release (decided 2026-04-26). Do not
# change it just to "use what's latest" at build time — bump intentionally
# in lockstep with sqlite-vec compatibility verification.
# See docs/research/installer-design.md §4.2 for compile flags rationale.

set -euo pipefail

PLATFORM="${1:?platform argument required (e.g. darwin-arm64)}"
OUT_DIR="${2:?out-dir argument required}"
SQLITE_VERSION="${SQLITE_VERSION:-3530000}"      # 3.53.0 (verified 2026-04-26)
SQLITE_YEAR="${SQLITE_YEAR:-2026}"               # path component on sqlite.org

mkdir -p "$OUT_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

zip_url="https://sqlite.org/${SQLITE_YEAR}/sqlite-amalgamation-${SQLITE_VERSION}.zip"
echo "[build-sqlite] downloading $zip_url"
curl -fsSL "$zip_url" -o "$tmp/s.zip"
(cd "$tmp" && unzip -q s.zip)
src_dir="$tmp/sqlite-amalgamation-${SQLITE_VERSION}"
[[ -d "$src_dir" ]] || { echo "[build-sqlite] amalgamation dir missing at $src_dir" >&2; exit 1; }

# Compile flags: enable loadExtension (the whole point), FTS5 (Clio uses
# it directly), JSON1 (our migrations use json_extract), RTREE (cheap
# future-proofing), and threadsafe (Bun serialises but this is the safer
# default). -O2 for release-grade optimisation.
CFLAGS_COMMON=(
  -DSQLITE_ENABLE_LOAD_EXTENSION=1
  -DSQLITE_ENABLE_FTS5=1
  -DSQLITE_ENABLE_JSON1=1
  -DSQLITE_ENABLE_RTREE=1
  -DSQLITE_THREADSAFE=1
  -O2
)

cd "$src_dir"

case "$PLATFORM" in
  darwin-arm64|darwin-x64)
    out="libsqlite3.dylib"
    arch_flag=()
    case "$PLATFORM" in
      darwin-arm64) arch_flag=(-arch arm64) ;;
      darwin-x64)   arch_flag=(-arch x86_64) ;;
    esac
    echo "[build-sqlite] clang ${CFLAGS_COMMON[*]} ${arch_flag[*]} -dynamiclib -install_name @rpath/${out} sqlite3.c -o ${out}"
    clang "${CFLAGS_COMMON[@]}" "${arch_flag[@]}" -dynamiclib -install_name "@rpath/${out}" sqlite3.c -o "$out"
    ;;
  linux-x64)
    out="libsqlite3.so"
    echo "[build-sqlite] gcc ${CFLAGS_COMMON[*]} -shared -fPIC sqlite3.c -o ${out}"
    gcc "${CFLAGS_COMMON[@]}" -shared -fPIC sqlite3.c -o "$out"
    ;;
  windows-x64)
    out="sqlite3.dll"
    echo "[build-sqlite] cl ${CFLAGS_COMMON[*]} /LD sqlite3.c /Fe:${out}"
    cl "${CFLAGS_COMMON[@]}" //LD sqlite3.c "//Fe:${out}"
    ;;
  *)
    echo "[build-sqlite] unsupported platform: $PLATFORM" >&2
    exit 1 ;;
esac

# Move into the output dir using the canonical filename Database.setCustomSQLite
# expects on each platform (db.ts §11.1). Windows always lands as
# libsqlite3.dll for consistency with the macOS/Linux naming.
final_name="libsqlite3${out##libsqlite3}"
case "$out" in
  sqlite3.dll) final_name="libsqlite3.dll" ;;
esac
cp "$out" "$OUT_DIR/$final_name"

echo "[build-sqlite] verifying loadExtension symbol present"
case "$PLATFORM" in
  darwin-*) symbol_tool="nm -gU" ;;
  linux-*)  symbol_tool="nm -D" ;;
  *)        symbol_tool=":" ;;     # skip on windows
esac
if [[ "$symbol_tool" != ":" ]]; then
  if ! $symbol_tool "$OUT_DIR/$final_name" 2>/dev/null | grep -q "sqlite3_load_extension"; then
    echo "[build-sqlite] FAIL: sqlite3_load_extension symbol missing from $OUT_DIR/$final_name" >&2
    echo "[build-sqlite] (the SQLITE_ENABLE_LOAD_EXTENSION=1 flag may have been stripped — check the compile invocation)" >&2
    exit 1
  fi
fi

bytes="$(wc -c < "$OUT_DIR/$final_name" | tr -d ' ')"
echo "[build-sqlite] ✓ $OUT_DIR/$final_name  ($bytes bytes, SQLite ${SQLITE_VERSION})"
