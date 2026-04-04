#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="${REPO_ROOT}/.mcpb-staging"
OUTPUT="${REPO_ROOT}/proton-bridge-mcp.mcpb"

echo "Building MCPB package..."

rm -rf "${STAGING}"
mkdir -p "${STAGING}/server"

# Copy compiled output
cp -r "${REPO_ROOT}/dist/." "${STAGING}/server/"

# Copy manifest
cp "${REPO_ROOT}/manifest.json" "${STAGING}/"

# Copy production-only node_modules
echo "Installing production dependencies into staging..."
cp "${REPO_ROOT}/package.json" "${STAGING}/"
cp "${REPO_ROOT}/package-lock.json" "${STAGING}/"
npm ci --omit=dev --prefix "${STAGING}" --ignore-scripts --silent
rm "${STAGING}/package.json" "${STAGING}/package-lock.json"

# Pack into .mcpb
echo "Packing..."
npx --yes mcpb pack "${STAGING}" "${OUTPUT}"

rm -rf "${STAGING}"
echo "Created ${OUTPUT}"
