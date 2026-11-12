# 미믹 CLI

미믹 클라우드 드라이브를 터미널에서 다루는 도구입니다. Node.js 20 이상만 있으면 되고, 따로 설치할 패키지가 없습니다.

## 설치

| 환경 | 명령 |
| --- | --- |
| macOS·Linux | `curl -fsSL https://<미믹 서버>/api/integrations/cli/install.sh \| sh` |
| Windows (PowerShell) | `irm https://<미믹 서버>/api/integrations/cli/install.ps1 \| iex` |
| npx (설치 없이) | `npx -y https://<미믹 서버>/api/integrations/cli/mimic-cli.tgz whoami` |
| npm 전역 설치 | `npm install -g https://<미믹 서버>/api/integrations/cli/mimic-cli.tgz` |
| Homebrew | 아래 "Homebrew" 참고 |

설치 스크립트는 서버에서 `mimic.js` 를 받아 `~/.mimic-cli`(Windows: `%LOCALAPPDATA%\Mimic\cli`)에 두고 `mimic` 명령을 만듭니다.
`mimic-cli.tgz` 는 서버가 그때그때 만드는 npm 패키지이고, 기본 서버 주소가 그 서버로 들어 있습니다.

### Homebrew

서버가 sha256 을 넣은 공식(`/api/integrations/cli/mimic.rb`)을 내려줍니다. Homebrew 는 공식을 탭(tap) 안에서만 설치하므로 로컬 탭에 받아 설치합니다.

```sh
brew tap-new --no-git mimic/local
F="$(brew --repository mimic/local)/Formula"; mkdir -p "$F"
curl -fsSL https://<미믹 서버>/api/integrations/cli/mimic.rb -o "$F/mimic.rb"
brew install mimic/local/mimic
```

## 로그인

```sh
mimic auth login      # 브라우저가 열리면 코드를 확인하고 승인 → 토큰이 ~/.mimic-cli.json 에 저장됨
mimic whoami
mimic auth logout
```

CLI 에 비밀번호를 입력하지 않습니다(기기 인가 방식). 서버·CI 처럼 브라우저가 없는 곳에서는 웹 **설정 > 액세스 및 통합**에서
개인 액세스 토큰을 만들어 `MIMIC_TOKEN` 환경변수에 넣으세요. 서버 주소는 `--server` 또는 `MIMIC_SERVER` 로 바꿉니다.

## 명령

```sh
mimic ls [폴더ID]
mimic upload ./movie.mp4 [폴더ID]
mimic download <파일ID> [저장 경로]
mimic share <파일ID> --days 7 --password
mimic stream <파일ID>                 # VLC·PotPlayer 등에 붙여 넣을 재생 주소
mimic offline add "magnet:?xt=..." "https://example.com/file.zip" --parent <폴더ID>
mimic tasks
mimic quota
mimic skill install [--dir 경로]      # AI 에이전트용 SKILL.md (기본 ~/.claude/skills/mimic)
```

모든 명령에 `--json` 을 붙이면 결과를 JSON 으로 출력합니다. CLI 같은 연결 앱의 전송량은 월 쿼터의 25% 까지만 쓸 수 있습니다.
