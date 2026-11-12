# v23: 초기 전송 파이프라인과 부가 창 지연 로딩

## 줄인 의존성

`src/main.ts`의 첫 HTML 렌더링 기회 뒤 Node 서버 페이지에서 `startupStorage`와 `appEntry`를
동시에 import합니다. NodeStorage는 언어·alert·DB 정규화·RisuSave 코덱을 더 이상 정적으로
import하지 않습니다. 해당 기능은 로그인 UI·에러 문구·채팅 읽기/쓰기 등 실제 사용 시점에
가져옵니다. 독립된 Buffer 의존성으로 큰 앱의 polyfill 실행을 기다리지 않습니다.

`getStartupStorage()`의 한 인스턴스를 AutoStorage도 사용합니다. 초기 인증의 JWT·탭 세션 ID·
진행 중 인증 Promise·bootstrap 상태를 이어받습니다. NodeStorage를 별도로 두 개 만들어
세션·인증·DB 다운로드를 반복하는 구조가 아닙니다.

## 읽기와 인계

1. `checkAuth(true, false)`로 비대화식 인증을 수행합니다. 쿠키가 없거나 잘못되었으면 비밀번호 UI를 불러오지 않고 종료합니다. 인증 재시도에도 이 구분을 전달합니다.
2. 서버가 확인한 bootstrap import 상태가 명시적으로 `blocking: false`일 때만 기존 `getItem`을 `startup-prefetch` 목적으로 실행합니다.
3. 기존 IDB 사본·작은 버전 확인·준비된 delta·manifest 기반 delta·SHA-256 검증·전체 읽기 복구를 그대로 사용합니다. 새로운 별도 전송 프로토콜은 없습니다.
4. 검증한 사본을 메모리에 보관합니다. 내용이 새로 내려온 경우에만 기존 deferred cache write에 대기시킵니다. 변경 없는 캐시의 전체 본문을 불필요하게 다시 쓰지 않습니다.
5. 정상 앱의 DB 읽기가 먼저 시작했다면 같은 사전 작업을 기다립니다. 읽기 세대 증가는 기다린 뒤 수행하므로, 진행 중 사전 읽기의 결과가 과거 세대로 잘못 버려지지 않습니다.
6. 메모리 사본에 대해 **현재 서버 revision/ETag를 다시 확인**합니다. 앱 파일을 받는 사이 다른 기기가 수정했다면 현재 변경분/전체 값으로 갱신합니다. 임의의 고정 시간 동안 이전 DB를 최신이라고 가정하지 않습니다.
7. 정상 bootstrap이 기존대로 디코딩·baseline 설정·DBState 적용·플러그인·형식 변환·UI·저장을 처리합니다. 사전 읽기는 이 순서를 앞당겨 실행하지 않습니다.

메모리 사본은 한 번 인계한 뒤 해제합니다. 새 본문의 선택적 디스크 사본은 기존 UI 표시 후
쓰기 큐에서 처리하며, 실패는 기존 재시도/진단으로 남깁니다. raw 데이터나 token을 진단에
추가하지 않습니다. 오래된 응답 쓰기 방지와 v21의 저장 승인 확인도 유지합니다.

현재 bootstrap 상태를 1초 이상 늦게 소비하면 import 상태를 다시 읽습니다. 차단/상태 실패·
구형 서버·사전 네트워크 실패·새 서버의 빈 DB는 기존 경로로 처리합니다. 사전 읽기에서
서버 DB를 생성하거나 로그인 비밀번호를 설정하지 않습니다.

초기 public shell이 있는 동안의 pointer/keyboard 이벤트는 `x-user-active`의 근거로 기록하지
않습니다. 사전 모듈이 일찍 등록한 리스너 때문에 로딩 화면의 터치가 나중 자동 저장의 writer
전환 근거가 되는 것을 방지합니다. writer claim·충돌 처리 자체는 바꾸지 않았습니다.

## 부가 창

LazyBoundary의 `activate`는 첫 import를 늦춥니다. 한번 활성화된 경계는 부모가 유지하는 동안
컴포넌트를 보존합니다. 자식의 기존 open store가 실제 표시/닫기를 계속 제어하므로 Proton의
입력·진행 상태, 업데이트 진행 상태, 후원 탭 상태를 매번 새로 만들지 않습니다. 닫힌 상태에서는
초기 placeholder도 렌더링하지 않습니다. 로드 실패 시 기존 재시도/닫기 제어를 제공합니다.

DB/플러그인 준비 전 대화 전송을 허용하거나 플러그인 실행 순서를 바꾸는 변경은 없습니다.
부가 UI 코드의 필요 시 로딩과 핵심 전송의 시작 시점을 분리한 작업입니다.

## 배포 검사

`scripts/check-startup-graph.mjs`는 빌드된 startupStorage 진입점에서 **정적 import/re-export**만
따라갑니다. 앱·DB·플러그인·언어 본체가 들어갔거나 raw 합계가 256 KiB를 넘으면 실패합니다.
현재 정적 의존성은 약 106 kB입니다. 실제 사용 때의 동적 import 크기나 전체 앱 크기의 상한은 아닙니다.
`precompress-assets --verify`는 v22처럼 최종 출력과 모든 gzip/Brotli의 바이트 일치를 확인합니다.

검증에는 비대화식 인증, 최초 로그인 fallback, import guard 만료, 사전 전송 실패, 그 사이 다른
기기 수정, 최신 revision 메타데이터 반영, 중복 IDB 읽기/쓰기 방지, loading shell의 gesture 보호,
부가 창 지연 import·재시도·인스턴스 보존과 실제 Chromium 경로를 포함했습니다.

서버 RAM 예산·저장 형식·API·HTTPS·설치 경로는 변경하지 않았습니다. 실제 회선이 대역폭 한도에
걸렸다면 앱과 DB가 같은 회선을 나눠 쓰므로, 겹친 시간 전체가 그대로 단축되지는 않습니다.

참고: [web.dev: Optimize long tasks](https://web.dev/articles/optimize-long-tasks),
[MDN: Lazy loading](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading),
[MDN: HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching).
