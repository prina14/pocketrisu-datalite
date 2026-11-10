# Loading Local Save File 구간 최적화

`v1.17.0-datalite.9`에 포함하는 소스 변경입니다. GitHub Release 워크플로는 검사·빌드·포터블 기동 확인 후 게시합니다.
이후 추가한 백업 설정·플러그인 목록 선읽기·메타데이터 조회 개선은 [독립 작업 동시 실행](startup-parallel.md)에 기록했습니다.

## 문구에 포함된 작업

`bootstrap.ts`는 `getItem('database/database.bin')` 호출 직전에
`Loading Local Save File...`을 표시합니다. 이 호출은 로컬 디스크만 읽지 않습니다.

1. IndexedDB에서 DB 사본·validator 읽기
2. 인증된 서버 요청으로 revision 확인
3. 변경됐다면 chunk manifest 계산과 서버 delta/전체 읽기
4. 응답 본문 읽기·delta 복원·검증
5. 선택적 브라우저 캐시 재저장

DB 디코딩은 이후의 `Decoding Local Save File...` 구간입니다.
실제 사용자 서버·DB의 단계별 시간이 없으므로 이 중 어느 것이 사용자 지연의
가장 큰 원인인지는 아직 확정하지 않았습니다. 아래는 코드상 직렬 대기를 줄인 변경입니다.

## 캐시 읽기와 서버 확인을 겹치기

기존에는 캐시 본문을 모두 읽고 나서 서버 revision probe를 시작했습니다.
이제 동일한 IndexedDB readonly 트랜잭션에서 작은 메타데이터 결과가 먼저 도착하면
그 값으로 probe를 시작합니다. 큰 본문은 계속 읽으며 둘 다 완료된 뒤 처리합니다.

캐시가 실제로 존재하고 본문의 etag·revision이 probe에 사용한 정보와 같을 때만
`304`로 재사용합니다. 본문이 없거나 정보가 불일치하면 새로 읽으며,
인증 실패를 캐시로 덮지 않습니다. probe를 지원하지 않는 구형 서버가 보낸
정상 본문도 추가 다운로드 없이 사용합니다.

지연을 제어한 자동 시험:

| 조건 | 기존 경로 | 개선 경로 |
| --- | ---: | ---: |
| 캐시 읽기 300ms, 서버 확인 600ms | 900ms | 600ms |

실제 Chromium IndexedDB에서도 8MiB 본문을 읽을 때 `metadata → request-start → body → request-done`
순서를 확인했습니다. 이 브라우저 시험은 로컬 probe 응답을 사용했으며 실제 사용자 서버의
성능 측정이나 Android 개선율이 아닙니다.

## 선택적 캐시 재저장을 첫 화면 뒤로

첫 DB 읽기만 `deferCacheWrite: true`로 실행합니다. 서버에서 받은 유효한 바이트는 즉시
디코딩 단계로 넘기고, 사본은 첫 렌더링 기회 뒤에 저장합니다. 플러그인 preload가
초기 DB 캐시 쓰기 트랜잭션의 전체 메타데이터 스캔을 기다리는 상황도 줄입니다.

캐시 기능을 끄는 변경은 아닙니다. DB 사본은 독립적인 바이트 snapshot으로 보관하고,
대기 중에는 최신 사본 하나만 유지합니다. 후속 일반 읽기가 더 최신 사본을 저장하면
오래된 대기를 취소합니다. 이미 시작한 저장과 후속 저장은 순서대로 처리해 오래된 완료가
새 사본을 덮어쓰지 않게 합니다. 캐시 저장 실패는 유효한 서버 읽기를 실패시키지 않습니다.

| 조건 | 기존 반환 시점 | 지연 저장 옵션의 반환 시점 |
| --- | ---: | ---: |
| 서버 읽기 300ms, 캐시 저장 800ms | 1,100ms | 300ms |

이는 가상 시계로 대기를 제어한 계약 시험이며 실제 로딩 속도 측정은 아닙니다.
페이지를 너무 일찍 닫아 선택적 저장이 끝나지 않으면 다음 접속에 다시 받을 수 있습니다.
서버 데이터 저장·쓰기 권한·채팅 저장 경로에는 영향을 주지 않습니다.

## 단계별 시간 확인

브라우저 콘솔에서 다음을 실행합니다. UI 카드나 추가 서버 요청은 만들지 않았습니다.

```js
performance.getEntriesByType('measure')
  .filter(entry => entry.name.startsWith('pocketrisu:startup:database-'))
  .map(entry => ({ name: entry.name, ms: Math.round(entry.duration) }))
```

| 항목 | 의미 |
| --- | --- |
| `database-cache-read` | IndexedDB 사본 읽기 |
| `database-version-check` | 인증·서버 revision 응답까지 |
| `database-delta-manifest` | 변경된 서버와 비교할 manifest 계산 |
| `database-server-read` | delta/전체 읽기 응답 헤더까지 |
| `database-response-body` | 응답 본문 수신 |
| `database-delta-apply` | delta 복원·검증 |
| `database-cache-write` | 첫 화면 이후 선택적 사본 저장 |
| `database-read` | 부팅 getItem 전체, 지연 저장은 제외 |
| `database-decode`·`database-apply` | 이후 디코딩·DB 적용 |

병렬 구간은 겹치므로 시간을 합산해 전체 로딩 시간으로 해석하면 안 됩니다.
실제 변경된 큰 DB의 첫 읽기·delta hash 계산·서버 직렬화 비용은 여전히 남습니다.

## 검증

- 이 DB 읽기 변경을 처음 검증한 시점: 앱 전체 **1,784개 통과**, 3개 건너뜀
- 타입 오류 0개, 기존 접근성 경고 4개
- 조기 probe·누락/불일치 사본·인증 실패·구형 서버·지연 저장·쓰기 순서·방어 복사·저장 실패 복구 검증
- 실제 Chromium 8MiB IndexedDB 메타데이터 콜백·네트워크 시작 순서와 콜백 실패 시 사본 보존 확인
- `git diff --check` 통과
