#!/bin/bash
# Generate PNG icons from SVG for PWA manifest
# Requires: either `rsvg-convert` (librsvg) or `inkscape` or `sharp-cli`
# Falls back to copying SVG if no converter available

ICON_SVG="public/icon.svg"
OUT_DIR="public"

if ! [ -f "$ICON_SVG" ]; then
  echo "No icon.svg found, skipping PNG generation"
  exit 0
fi

# Try rsvg-convert (common on Linux)
if command -v rsvg-convert &>/dev/null; then
  echo "Using rsvg-convert to generate PNGs..."
  rsvg-convert -w 192 -h 192 "$ICON_SVG" -o "$OUT_DIR/icon-192.png"
  rsvg-convert -w 512 -h 512 "$ICON_SVG" -o "$OUT_DIR/icon-512.png"
  rsvg-convert -w 512 -h 512 "$ICON_SVG" -o "$OUT_DIR/icon-maskable-512.png"
  echo "Icons generated successfully"
  exit 0
fi

# Try sips (macOS built-in — converts SVG on some versions)
if command -v sips &>/dev/null && [[ "$OSTYPE" == "darwin"* ]]; then
  echo "Note: sips may not support SVG. If icons are missing, install librsvg: brew install librsvg"
fi

echo "WARNING: No SVG-to-PNG converter found. PWA install prompt may not work."
echo "Install librsvg: brew install librsvg (macOS) or apt install librsvg2-bin (Linux)"
echo "Then run: bash packages/dashboard/scripts/generate-icons.sh"
