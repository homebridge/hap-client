#!/usr/bin/env bash

set -uo pipefail


# Defaults to dry run unless --execute flag or EXECUTE=1 env var is set
EXECUTE=${EXECUTE:-0}

# Normalize EXECUTE: accept "true"/"false" as well as "1"/"0"
if [ "${EXECUTE}" = "true" ] || [ "${EXECUTE}" = "1" ]; then
  EXECUTE=1
else
  EXECUTE=0
fi

# Parse command line options
while [ $# -gt 0 ]; do
  case "$1" in
    --execute)
      EXECUTE=1
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--execute]  (or set EXECUTE=1 to enable execution)" >&2
      exit 1
      ;;
  esac
  shift
done

# Read package version from package.json
LATEST_VERSION=$(jq -r .version package.json)
if [ -z "$LATEST_VERSION" ] || [ "$LATEST_VERSION" = "null" ]; then
  echo "Error: could not extract version from package.json" >&2
  exit 1
fi
echo "Latest version found in package.json: $LATEST_VERSION"
if [ "$EXECUTE" = "0" ]; then
  echo "*** DRY RUN MODE: delete commands will be printed but not executed ***"
fi
echo ""

DELETED_RELEASES=()
DELETED_TAGS=()

# Helper to write to both stdout and, only when running in a GitHub Actions
# workflow context (GITHUB_STEP_SUMMARY is set), also append to the job summary.
summary() {
  echo "$1"
  if [ -n "$GITHUB_STEP_SUMMARY" ]; then
    echo "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

echo ""
echo "Finding pre-release GitHub releases..."
while read -r TAG; do
  BASE_VERSION="${TAG%%-*}"
  BASE_VERSION_NO_V="${BASE_VERSION#v}"
  if [ "$(printf "%s\n%s" "$BASE_VERSION_NO_V" "$LATEST_VERSION" | sort -V | tail -n1)" == "$LATEST_VERSION" ]; then
    if [ "$EXECUTE" = "0" ]; then
      echo "* [DRY RUN] Would run: gh release delete \"$TAG\" --yes"
      DELETED_RELEASES+=("$TAG")
    else
      echo "* Deleting GitHub release: $TAG"
      gh release delete "$TAG" --yes
      DELETED_RELEASES+=("$TAG")
    fi
  else
    echo "* Skipping release: $TAG (base version $BASE_VERSION_NO_V is newer than $LATEST_VERSION)"
  fi
done < <(gh release list --limit 100 --json tagName --jq '.[] | select(.tagName | test("-"; "i")) | .tagName')

echo ""
echo "Finding pre-release Git tags..."
git fetch --tags
while read -r TAG; do
  BASE_VERSION="${TAG%%-*}"
  BASE_VERSION_NO_V="${BASE_VERSION#v}"
  if [ "$(printf "%s\n%s" "$BASE_VERSION_NO_V" "$LATEST_VERSION" | sort -V | tail -n1)" == "$LATEST_VERSION" ]; then
    if [ "$EXECUTE" = "0" ]; then
      echo "* [DRY RUN] Would run: git push origin --delete refs/tags/$TAG"
      DELETED_TAGS+=("$TAG")
    else
      echo "* Deleting tag: $TAG"
      git push origin --delete "refs/tags/$TAG"
      DELETED_TAGS+=("$TAG")
    fi
  else
    echo "* Skipping tag: $TAG (base version $BASE_VERSION_NO_V is newer than $LATEST_VERSION)"
  fi
done < <(git tag -l "*-*")

summary ""
summary "## GitHub Pre-release Cleanup Summary"
if [ "$EXECUTE" = "0" ]; then
  summary "> **DRY RUN MODE** - no releases or tags were actually deleted."
fi
summary "* Latest version: \`$LATEST_VERSION\`"
if [ ${#DELETED_RELEASES[@]} -eq 0 ]; then
  summary "* No GitHub releases were deleted."
else
  summary "* Deleted ${#DELETED_RELEASES[@]} GitHub releases:"
  for TAG in "${DELETED_RELEASES[@]}"; do
    summary "  * \`$TAG\`"
  done
fi
if [ ${#DELETED_TAGS[@]} -eq 0 ]; then
  summary "* No Git tags were deleted."
else
  summary "* Deleted ${#DELETED_TAGS[@]} Git tags:"
  for TAG in "${DELETED_TAGS[@]}"; do
    summary "  * \`$TAG\`"
  done
fi
