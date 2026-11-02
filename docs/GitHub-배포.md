# GitHub 배포 안내

소스 코드는 Git 저장소에 올리고, Windows 실행 파일은 GitHub Releases의 첨부 파일로 배포합니다. 현재 `bin/`은 `.gitignore`에 포함되어 있으므로 소스를 복제하거나 소스 ZIP을 받아도 EXE는 들어 있지 않습니다.

## 소스 저장소 구성

프로젝트 루트인 `hwpcopilot/`을 저장소 기준으로 사용합니다. 다음 파일과 폴더가 소스에 포함됩니다.

```text
src/
test/
docs/
.gitignore
README.md
package.json
package-lock.json
```

`node_modules/`, `bin/`, `artifacts/`, `.cache/`, 로그와 `.env`는 현재 `.gitignore`에서 제외합니다. 로컬 설정은 앱이 `%APPDATA%\HWP Copilot`에 저장하므로 프로젝트에 포함할 필요가 없습니다.

업로드 전에 VS Code의 소스 제어 목록 또는 `git status`에서 실제 포함할 파일을 확인하세요. 아직 Git 저장소를 만들지 않았다면 프로젝트 폴더에서 시작할 수 있습니다.

```powershell
git init
git add src test docs .gitignore README.md package.json package-lock.json
git status
git commit -m "Add HWP Copilot desktop helper"
```

이미 저장소가 있다면 초기화는 생략합니다. 이후 GitHub에서 만든 저장소를 원격 저장소로 연결하고 현재 브랜치를 푸시합니다. 원격 주소는 본인 저장소의 URL을 사용하세요.

## 실행 파일 배포

1. 프로젝트 루트에서 `npm.cmd ci`로 의존성을 설치합니다.
2. `npm.cmd test`, `npm.cmd run test:desktop`으로 검증합니다.
3. `npm.cmd run dist`로 포터블 EXE를 만듭니다.
4. 필요하면 `test/packaged-smoke.ps1`로 빌드한 EXE 자체를 검증합니다. 명령은 [개발 가이드](개발-가이드.md)를 참고하세요.
5. GitHub 저장소의 Releases에서 검증한 커밋을 대상으로 릴리스를 만듭니다. 현재 버전 태그 예시는 `v0.3.1`입니다.
6. `bin/HWP-Copilot-0.3.1-x64.exe`, `docs/팀원-시작하기.md`, `docs/API-한도-오류.md`를 첨부하고 변경 사항·지원 환경·검증 범위를 적습니다.
7. 배포 후 README의 실행 안내에 실제 릴리스 링크를 추가합니다.

현재 EXE는 약 110MB로 GitHub 일반 Git 저장소의 단일 파일 제한인 100MiB를 초과합니다. `bin/`을 강제로 Git에 추가하지 말고 릴리스 첨부 파일로 전달하세요. [GitHub 파일 크기 안내](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

Releases는 소스 태그에 실행 파일과 릴리스 설명을 연결해 배포하는 기능입니다. 자동으로 제공되는 소스 ZIP과 직접 첨부한 EXE는 서로 다른 다운로드입니다. [GitHub Releases 안내](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

## 릴리스 설명 예시

```markdown
## HWP Copilot 0.3.1

한글 창 옆에서 사용하는 AI 보고서 작성 도우미입니다.

- Windows x64용 포터블 EXE 제공
- 한글 문서 읽기, 커서 위치에 추가, 선택 문장 교체
- OpenAI·Claude·Gemini·OpenAI 호환 API 연결
- 패널 위치 추적과 독립 창 전환
- 대화형 화면, 질문창 바로 위 사용량 바와 하단 입력창 고정

### 실행

첨부된 HWP-Copilot-0.3.1-x64.exe를 실행하세요.
Windows용 한글 데스크톱이 필요하며, API 키는 각자 입력합니다.

### 검증 범위

한글 2018 / 10.0.0.14850의 새 문서에서 텍스트 편집을 검증했습니다.
다른 한글 버전은 실기기 확인이 필요합니다.
표·이미지·세부 서식 생성은 지원하지 않습니다.
```

파일 이름, 버전, 검증 항목은 실제 배포 결과에 맞춰 수정하세요. 저장소 주소와 라이선스는 이 문서에서 임의로 지정하지 않았습니다.

[프로젝트 소개로 돌아가기](../README.md)
