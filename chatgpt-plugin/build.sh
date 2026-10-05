#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
package_dir="$repo_root/chatgpt-plugin"
version="$(node -p "require('$package_dir/plugin.json').version")"
output="$package_dir/dist/tako-chatgpt-plugin-$version.zip"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

cp "$package_dir/plugin.json" "$staging/plugin.json"
cp -R "$repo_root/skills" "$staging/skills"
cp -R "$package_dir/assets" "$staging/assets"

mkdir -p "$package_dir/dist"
rm -f "$output"
(cd "$staging" && zip -qrX "$output" plugin.json skills assets)
echo "$output"
