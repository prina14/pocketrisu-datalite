# 서버 사전 준비와 재접속 경로 — v22

## 요청 흐름

1. 브라우저는 인증 후 IndexedDB의 **실제 사본**에 속한 ETag/revision을 보냅니다. 사본 메타데이터를 먼저 읽어 네트워크 확인과 본문 로딩을 겹치는 기존 동작을 유지합니다.
2. 같으면 본문 없는 304입니다. 같은 바이트를 확인할 수 있는 기존 persisted index 검사도 유지합니다.
3. 다르면 준비된 `(이전 조각 정보, 최신 불변 snapshot, 전송 encoding)` 조합을 찾습니다. 완성된 delta가 있고 전체 전송보다 작을 때만 버전 확인 응답으로 보냅니다.
4. 없으면 작은 metadata 응답 후 기존 manifest 기반 `/api/read-delta`로 진행합니다. 브라우저 사본과 같이 저장된 manifest가 있으면 재사용합니다.
5. 브라우저는 복원한 전체 값의 SHA-256을 검사합니다. 잘못된 사본·조각 정보·패킷·전송 중단이면 인증된 전체 읽기로 복구합니다.

`x-read-prepared-accept: 1`로 요청한 DB 읽기에만 3번을 허용합니다. 일반적인
`x-read-check-only: 1` 진단은 계속 본문 없는 응답입니다. 구형 서버는 새 헤더를 무시하고
기존 읽기로 동작합니다. packet·manifest·저장 형식은 바꾸지 않았습니다.

버전 확인 시 찾은 snapshot이 디스크 flush 중 교체되면 준비된 패킷을 보내지 않습니다.
새로운 view에서 정상 전체 읽기를 진행합니다. 캐시용 백그라운드 읽기는 v21처럼 승인된
메모리 view를 읽을 수 있지만 현재 편집기의 저장 ETag를 바꾸지 않습니다.

## 준비 시점과 한도

기존 서버 snapshot 준비와 같이 저장/읽기 이후 약 1초 debounce를 사용합니다. 최신 바이너리·
조각 해시·전체 gzip/Brotli를 준비한 뒤 최근 사본에 대한 작은 delta를 계산·압축합니다.
전경 읽기가 있거나 최신 view가 교체되면 다음 사본 준비를 중단합니다. 사본 사이에는
이벤트 루프에 제어를 돌려줍니다. 진행 중인 같은 패킷 계산·압축 Promise도 공유합니다.

- 이전 사본은 **본문 없이 manifest만 최대 4개, 합계 JSON 2 MiB**를 기억합니다.
- 완성된 delta는 패킷 원본 1 MiB 이하만 보관합니다. 최신 target에 최대 4개이며 raw와 두 압축 결과를 고려한 보수적 예약 상한은 16 MiB입니다.
- 최신 snapshot 보관 64 MiB의 기존 예산과 별도입니다. 요청·워커·생성 중의 순간 할당까지 이 한도로 제한한다는 뜻은 아닙니다.
- target은 snapshot 객체별 WeakMap으로 구분합니다. 오래된 압축 완료가 새 snapshot의 응답을 덮을 수 없습니다.
- 서버 재시작·DB 무효화/복원 시 기억을 초기화합니다. 이를 위해 별도 DB 파일이나 오래된 전체 DB 버전을 디스크에 쌓지 않습니다.
- 첫 요청, 오래된 사본, 큰 변경분, 아직 준비 중인 경우에는 기존 계산/전송으로 처리합니다.

현재 전달한 최신 snapshot의 조각 정보도 기억하므로 다음 수정이 생기면 이전 버전에서의
delta를 준비할 수 있습니다. 전송 이력은 브라우저가 저장했다는 승인으로 취급하지 않습니다.
PC와 모바일이 같은 사본이면 같은 변경분을 공유하며, 다른 사본이면 별도 항목입니다.

## 브라우저와 정적 파일

사본 쓰기 직전에 manifest를 준비해 정확한 본문과 같은 트랜잭션으로 저장합니다. 부팅에서는
기존처럼 첫 UI 뒤의 deferred cache write에 속합니다. 다른 본문으로 교체하면 예전 manifest도
사라집니다. 사본 용량 관리에 manifest 크기도 포함합니다. 실패는 선택적 캐시 실패로 처리하고
기존 재시도·진단을 유지합니다. revision만 바뀌고 ETag가 같으면 같은 본문/manifest를 유지합니다.

빌드의 JS·CSS gzip(레벨 9)/Brotli(품질 6)는 해시 파일명에 `.gz`/`.br`을 붙여 배포합니다.
서버는 빌드가 만든 목록에 있는 파일만 선택하고 기존 MIME·Accept-Encoding 협상·Vary·조건부
요청·immutable 캐시를 유지합니다. 소스맵·DB·개인 데이터는 이 정적 압축 목록에 넣지 않습니다.
부재한 변형과 구형 빌드는 기존 정적 파일/동적 압축으로 처리합니다. 기존 Brotli 품질 4의
반복 서버 압축을 빌드 작업으로 옮겼으며 새 런타임 의존성은 없습니다.

## 진단 해석

- 응답 `x-read-prepared-delta: probe-hit`: 버전 확인 응답에서 완성된 패킷을 보냈습니다.
- `/api/read-delta`의 `x-read-prepared-delta: hit`: 같은 manifest/target의 패킷 계산 또는 완성 결과를 공유했습니다. 반드시 요청 이전에 완료됐다는 뜻은 아닙니다.
- `read-manifest`의 `reused: true`: 브라우저에 저장된 조각 정보를 재사용했습니다.
- `read-delta-response`: 실제 delta 수신이며 준비된 경로 여부를 포함합니다.
- 진단 v3의 `플러그인초기화`: 최상위 비동기 코드 완료까지입니다. 앱의 기존 `plugins-v3-execute`는 실행 시작/iframe 설치 시간이라 의미가 다릅니다. 이후 타이머·이벤트 작업이나 훅 전체 수명까지 재지는 않습니다. 아직 끝나지 않거나 해제된 항목은 pending일 수 있습니다.
- `plugin-write-request`: V3의 setDatabaseLite/setDatabase/setArgument 호출 출처이며 실제 내용 변화는 patch/서버 결과로 함께 판단합니다. 이름·메서드·root 필드만 기록하고 값·인수 키·메시지·API 키는 기록하지 않습니다. 각 진단 목록은 최대 40개이고 메모리에만 있습니다.

V3 실행은 이미 병렬이며 설정·관리 화면과 외부 목록도 지연 로딩합니다. 플러그인 코드를
순서 없이 더 늦추거나 준비되지 않은 편집 화면을 활성화하는 변경은 하지 않았습니다.
개별 플러그인 측정으로 실제 병목을 찾은 뒤 의존성이 없는 작업을 분리하는 것이 다음 단계입니다.

참고: [Node.js zlib 압축 결과 캐싱](https://nodejs.org/docs/latest-v24.x/api/zlib.html#compressing-http-requests-and-responses),
[MDN HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching),
[MDN Vary](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Vary).
