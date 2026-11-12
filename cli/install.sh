#!/bin/sh
# 미믹 CLI 설치(macOS·Linux): curl -fsSL <미믹 서버>/api/integrations/cli/install.sh | sh
set -e
SERVER="${MIMIC_SERVER:-__MIMIC_SERVER__}"
case "$SERVER" in __*) SERVER="http://localhost:4300" ;; esac
DIR="${MIMIC_HOME:-$HOME/.mimic-cli}"
BIN="${MIMIC_BIN:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 이상이 필요합니다. https://nodejs.org 에서 설치하거나 'brew install node' 를 실행하세요." >&2
  exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 20 ]; then
  echo "Node.js 20 이상이 필요합니다(현재 $(node -v))." >&2
  exit 1
fi

mkdir -p "$DIR" "$BIN"
curl -fsSL "$SERVER/api/integrations/cli/mimic.js" -o "$DIR/mimic.js"
curl -fsSL "$SERVER/api/integrations/cli/package.json" -o "$DIR/package.json"
cat > "$BIN/mimic" <<WRAP
#!/bin/sh
MIMIC_SERVER="\${MIMIC_SERVER:-$SERVER}" exec node "$DIR/mimic.js" "\$@"
WRAP
chmod +x "$BIN/mimic"

echo "미믹 CLI 를 설치했습니다: $BIN/mimic"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "PATH 에 $BIN 을 추가하세요: export PATH=\"$BIN:\$PATH\"" ;; esac
echo "다음 단계: mimic auth login"
