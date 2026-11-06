# imbank-crash

Crashlytics 이슈 뷰어 로컬 서버. Firebase 프로젝트 → 앱(iOS/Android)을 골라 Crashlytics 이슈 목록과 이슈별 기기 로그(breadcrumb)를 본다.

## 준비

- Node.js 18 이상 (외부 패키지 없음)
- Firebase CLI 로그인: `firebase login`

별도 로그인 화면은 없다. 서버가 `firebase login`으로 저장된 계정(`~/.config/configstore/firebase-tools.json`)으로 Firebase/Crashlytics API를 호출한다. 그 계정이 접근할 수 있는 프로젝트만 보인다.

## 실행

```bash
npm start
```

http://localhost:5177 접속 → 프로젝트, OS, 앱, 기간 선택 → "이슈 목록 가져오기" → 이슈 클릭 시 기기 로그(최대 100개) 표시.

## 설정

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `5177` | 앱 서버 포트 |

## 문제 해결

- `firebase login을 먼저 실행하세요` → 터미널에서 `firebase login`
- `토큰 갱신 실패` → `firebase login --reauth`
- 다른 계정으로 보려면 `firebase logout` 후 다시 `firebase login`
