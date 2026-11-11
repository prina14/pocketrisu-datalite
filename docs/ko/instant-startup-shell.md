# 앱 준비와 첫 화면 표시 분리

v1.17.0-datalite.13에 포함된 변경입니다.

## 목표와 표시 순서

전체 데이터·플러그인 처리를 1초 안에 끝내는 대신 사이트의 기본 화면을 먼저 표시합니다.
이전 HTML은 전체 stylesheet를 기다리고, 정적 main import는 앱·폴리필·저장소·화면 모듈을
준비한 뒤 Svelte를 마운트했습니다. 앱 데이터 로딩 시작 전에도 이 비용이 있었습니다.

1. HTML 자체의 작은 inline CSS로 PocketRisu 헤더와 캐릭터 영역의 빈 레이아웃을 표시합니다.
   외부 CSS·폰트·이미지·DB·앱 JS가 필요하지 않습니다. 스켈레톤은 실제 캐릭터나 버튼이 아닙니다.
2. 작은 main 진입점은 렌더링 기회 이후 appEntry를 동적 import합니다. 전체 앱 CSS도 이 경로에서
   불러옵니다. 숨김 탭·throttling에는 타이머 복귀를 사용해 앱 시작이 무기한 대기하지 않게 합니다.
3. Svelte 마운트 후에도 같은 레이아웃과 현재 준비 상태를 표시합니다. 인증 입력과 가져오기 화면은
   기존 경로를 사용합니다. 인증·가져오기 보호·최신 DB 적용 후 실제 캐릭터 이름 미리보기로 전환합니다.
4. 기존 플러그인·형식 이관·저장 기준 준비가 끝나면 정상 화면을 표시하고 편집·전송을 허용합니다.

앱/CSS 청크를 읽지 못하면 정적 화면에 새로고침 버튼을 표시합니다. JavaScript를 끈 경우에는
기존 안내가 보이도록 정적 레이아웃을 숨깁니다. 사적인 이름을 localStorage에 따로 저장하거나
인증 전에 과거 DB를 표시하는 방식은 사용하지 않습니다.

## 함께 조정한 부분

- 활성 V2 플러그인의 저장소 값은 캐릭터 미리보기 프레임 대기와 겹쳐 사전 읽기를 시작합니다.
  기존 저장소의 공유 promise를 사용하며 V2 실행 전에 전체 값 준비를 여전히 기다립니다.
  사전 읽기 실패는 기존 초기화에서 재시도하고, 값 준비 실패 시 V2 실행을 막는 보호도 유지합니다.
- `auth-test_auth`, `auth-password-prompt`, `auth-crypto`, `auth-login`, `auth-session` 등으로
  요청과 사용자의 비밀번호 입력 대기를 구분합니다. 사용자 입력 내용이나 토큰은 기록하지 않습니다.
- 플러그인은 `plugins-index-wait`, `plugins-storage-preload`, `plugins-v2-execute`,
  `plugins-v3-execute`로 분리합니다. 상위 `plugins`와 합산하지 않습니다.
- DB의 revision 일치 시 로컬 사본 재사용, 변경 시 delta·전체 읽기 복구와 무결성 검증은 유지합니다.
  이전 측정의 delta 실행만으로 불필요한 DB 변경이라고 확정할 수 없어 변경 여부를 임의로 무시하지 않습니다.

## 측정과 한계

`navigation-to-shell-frame`은 HTML 레이아웃의 렌더링 기회, `navigation-to-preview-frame`은
최신 DB의 실제 이름 표시 기회, `navigation-to-ui-frame`은 최종 앱의 렌더링 기회입니다.
처음 두 항목은 채팅 전송 가능 시점이 아닙니다. 실제 첫 콘텐츠 표시 시간은 브라우저의
`first-contentful-paint`(FCP)로 별도 확인합니다. 모든 작업 완료나 물리적 화면 출력을 보장하는 지표는 아닙니다.

실제 index.html과 경량 진입점을 Chromium에서 실행하고 appEntry 요청을 응답하지 않은 상태로
두었을 때 FCP는 PC 80ms, 모바일 화면 크기 36ms였습니다. 앱 마운트 전 레이아웃 표시,
외부 CSS 요청 0개, 가로 넘침 없음과 청크 503 응답 시 새로고침 버튼을 확인했습니다.
로컬 HTTP 합성 시험이며 실제 Android 기기나 Oracle 접속 속도·프로덕션 번들 측정은 아닙니다.
HTML 자체 수신이나 DNS·연결이 늦는 환경까지 1초 이내를 보장할 수는 없습니다.

검사: 앱 1,833개 통과·3개 건너뜀. 타입 오류 0개, 기존 접근성 경고 4개.

Vite 개발 앱과 실제 Node 서버를 연결한 Chromium 통합 시험에서도 PC 로그인, 모바일 재접속,
최신 DB 미리보기→최종 UI 전환, 설정 열기·닫기를 확인했고 런타임 예외는 없었습니다.
서버 DB를 바꾼 두 번째 접속에서는 delta 복원을 확인했으며, 이후 수정 없이 세 번째 접속에서는
`/api/read`의 304 응답 한 번만 발생하고 DB 본문·delta 요청은 없었습니다.
개발 앱 검증 결과입니다. 프로덕션 빌드 검증은 아래 릴리스 확인과 구분합니다.

## 사용자 기기에서 측정

업데이트를 적용한 뒤 사이트를 평소처럼 열고, 최종 화면이 나온 후 2초 정도 뒤에 콘솔에서 실행합니다.
기존 명령은 그대로 사용할 수 있으며 새 shell·인증·플러그인 항목이 함께 나옵니다.

```js
console.table(
  performance.getEntriesByType('measure')
    .filter(e => e.name.startsWith('pocketrisu:startup:'))
    .map(e => ({
      단계: e.name.replace('pocketrisu:startup:', ''),
      시작초: +(e.startTime / 1000).toFixed(2),
      소요초: +(e.duration / 1000).toFixed(2)
    }))
);
```

첫 콘텐츠가 실제로 표시되기까지 걸린 시간은 다음으로 확인합니다.

```js
console.table(
  performance.getEntriesByType('paint').map(e => ({
    단계: e.name,
    접속후초: +(e.startTime / 1000).toFixed(2)
  }))
);
```

- `first-contentful-paint`: 브라우저가 처음 텍스트·그림을 표시한 시점. 1초 이내인지 볼 기준입니다.
- `navigation-to-shell-frame`: 기본 레이아웃 렌더링 기회. FCP와 실행 순서에 따라 조금 다를 수 있습니다.
- `navigation-to-preview-frame`: 인증·최신 DB 확인 후 실제 이름 표시 기회.
- `navigation-to-ui-frame`: 최종 앱 렌더링 기회. 모든 백그라운드 작업 완료를 뜻하지 않습니다.
- `auth-password-prompt`: 사용자의 비밀번호 입력 대기. 자동 처리 성능과 구분합니다.

개발자 도구의 Network에서 Disable cache는 끄고, Throttling은 No throttling으로 맞춥니다.
업데이트 직후 첫 접속은 새 앱 파일 다운로드가 포함되므로 따로 기록합니다. 이후 DB 내용을
바꾸지 않고 일반 새로고침을 2~3회 반복합니다. 강력 새로고침·캐시 삭제는 일상 재접속과 조건이
다르므로 별도 시험으로 구분합니다. 뒤로가기로 BFCache에서 복원되거나 이미 열린 탭에 돌아오면
새 navigation 측정이 시작되지 않을 수 있어, 비교에는 일반 새로고침을 사용합니다.
항목은 상하위 작업이 겹치므로 소요 시간을 모두 더하지 않습니다.

## v13 프로덕션 빌드 확인

프로덕션 빌드가 성공했고 실제 Node 서버·Chromium에서 PC 첫 로그인, 모바일 재접속,
캐릭터 미리보기→최종 UI 전환, 설정 열기·닫기와 수식 CSS·로컬 폰트를 확인했습니다.
런타임 예외는 없었습니다. HTML의 초기 외부 stylesheet는 0개이며 HTML이 직접 참조하는
main JS는 4,059 B였습니다. 이후 앱 전체 다운로드 비용을 뜻하는 수치는 아닙니다.

로컬 합성 DB 시험의 FCP는 PC 56ms, 모바일 화면 크기 40ms였으며 변경 없는 세 번째 접속도
40ms였습니다. 두 번째 접속에서는 의도적으로 서버 DB를 바꿔 delta 복원을 확인했고,
세 번째 접속에서는 DB 읽기가 작은 revision 확인 304 한 번으로 끝났습니다.
외부 인터넷 요청을 차단한 로컬 시험이며 실제 Android 기기·Oracle 서버 성능 보장값은 아닙니다.
