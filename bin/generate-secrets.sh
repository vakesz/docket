#!/bin/sh
# Generate AUTH_SECRET and SECRETS_KEY into .env (creating it from .env.example
# on first run). Existing values are preserved unless --force is passed.
#
#   bin/generate-secrets.sh           # fill blank AUTH_SECRET / SECRETS_KEY
#   bin/generate-secrets.sh --force   # also overwrite existing values
set -e

cd "$(dirname "$0")/.."

ENV_FILE=.env
EXAMPLE_FILE=.env.example
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      echo "Usage: $0 [--force]"
      echo "  Generates AUTH_SECRET and SECRETS_KEY in $ENV_FILE."
      echo "  --force  overwrite existing non-empty values."
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required but not found in PATH." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$EXAMPLE_FILE" ]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    echo "Created $ENV_FILE from $EXAMPLE_FILE."
  else
    : > "$ENV_FILE"
    echo "Created empty $ENV_FILE."
  fi
fi

set_secret() {
  name=$1
  current=$(grep "^${name}=" "$ENV_FILE" | head -1 | cut -d'=' -f2-)
  if [ -n "$current" ] && [ "$FORCE" -eq 0 ]; then
    echo "$name already set; pass --force to overwrite."
    return
  fi
  value=$(openssl rand -base64 32 | tr -d '\n')
  if grep -q "^${name}=" "$ENV_FILE"; then
    # macOS `sed -i` needs an empty arg; GNU `sed -i` rejects it. Use a portable
    # tmpfile dance instead.
    tmp=$(mktemp)
    awk -v k="$name" -v v="$value" '
      $0 ~ "^"k"=" { print k"="v; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  fi
  echo "Set $name."
}

set_secret AUTH_SECRET
set_secret SECRETS_KEY

echo
echo "Done. Inspect $ENV_FILE and fill in PUBLIC_BASE_URL + Postgres credentials."
