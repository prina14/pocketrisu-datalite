# DataLite 개발자용 패치 노트

## DataLite 34: 스냅샷 한도 조회

- 스냅샷과 현재 DB의 chunk hash 차집합을 SQLite `EXCEPT`로 먼저 구해 공유 chunk의 크기를 불필요하게 조회하지 않습니다. 중복 hash는 한 번만 계산하며 기존 한도·삭제 기준을 유지합니다.
- 실제 서버의 스냅샷 한도 API 5회 중앙값은 196ms → 117ms였습니다. 건수·실사용량·논리 크기·한도는 전후 모두 같았습니다. 새 측정 범위는 94–243ms로 편차가 남습니다.
- 재시작 직후 첫 대시보드에서 약 2.86초 지연도 관찰했습니다. 후속 API는 202–326ms였으므로 이 변경으로 콜드 대시보드의 지연까지 해결됐다고 보지는 않습니다.
- 실제 SQLite에서 공유·중복 chunk, raw·없는 base, stale manifest의 크기를 독립된 집합 오라클과 비교하고 전체 서버 검사 283개를 통과했습니다.

## DataLite 33: 첫 화면의 미세한 배치 변화

- 로딩 화면의 Recent Chats 제목을 실제 화면과 같은 위치에 배치해 전환 시 16px 이동을 없앴습니다. Recently Uploaded의 위치와 기존 182px 예약 높이는 유지합니다.
- 초기 로딩 화면에도 앱과 같은 6px 스크롤바 폭을 적용해 좁은 Chrome 화면에서 콘텐츠 폭이 9px 바뀌는 현상을 없앴습니다.
- 1440px·390px 화면에서 로딩 전후 최근대화 제목·영역과 Recently Uploaded의 위치를 비교했습니다. 최근대화 숨김 설정에는 기존 배치를 적용합니다.

## DataLite 32: 대시보드 통계 집계

- 자산 크기 통계에 필요한 건수·바이트만 SQLite에서 집계합니다. 수만 개의 키와 행 객체를 Node로 가져오지 않습니다.
- 대시보드 요청 안에서 이미 구한 자산·아카이브·첨부 파일 합계를 백업 예상 크기 계산에 재사용합니다. 다른 요청의 결과를 캐싱하지 않으므로 수동 새로고침은 최신 값을 조회합니다.
- `/api/db/stats`의 `Server-Timing`에 디스크·스냅샷·접두어 집계 등 서로 겹치지 않는 단계 시간을 제공합니다. 백업 예상 크기와 저장 형식은 유지합니다.
- 실제 서버 5회 측정에서 overview API 중앙값은 409ms → 372ms, backup API는 132ms → 106ms였습니다. 시간 순서대로 측정한 관찰값이며 OS 캐시와 서버 부하의 영향이 있습니다. 전체 화면 준비 시간의 개선률이나 콜드 대시보드 지연 해결을 의미하지 않습니다.
- SQL 집계와 기존 목록 합계의 일치, Unicode·와일드카드 포함 접두어, 0바이트 합계 재사용, 대시보드 중복 읽기 방지를 회귀검사합니다.

대상: **PocketRisu DataLite `v1.17.0-datalite.1`**

Base: PocketRisu `v1.17.0`, commit `40851fc9831856a36cb5c14799c1f501f32dc133`.

브라우저 재접속 시 메인 DB 및 플러그인 저장소의 중복 전송을 줄이기 위해 persistent client cache, conditional read, content-defined chunk delta를 추가했습니다. 서버의 영구 저장 형식과 `.bin` 백업 형식은 변경하지 않았습니다.

## Persistent transfer cache

- IndexedDB `pocketrisu-transfer-cache-v1`에 본문과 서버 validator를 보관합니다.
- 본문 저장소 `copies`와 버전·크기 메타데이터 저장소 `versions`를 분리합니다. 버전 목록 조회 시 대용량 본문을 함께 로드하지 않습니다.
- 전체 캐시 상한은 512 MiB이며, 초과 시 저장 시각이 오래된 항목부터 제거합니다.
- IndexedDB 접근 실패·quota 초과·사본 유실 시 네트워크 읽기로 fallback합니다.
- HTTP IP 접속을 지원하기 위해 CacheStorage와 `crypto.subtle`에 의존하지 않습니다. 브라우저 측 SHA-256은 기존 `@aws-crypto/sha256-js`를 사용합니다.
- 로컬 사본은 서버 인증 및 validator 확인 후 사용합니다. 오프라인 부팅 기능은 추가하지 않았습니다.

## Conditional read

`GET /api/read`에 클라이언트의 conditional read를 연결했습니다.

| 대상 | Validator |
| --- | --- |
| `database/database.bin` | 기존 MD5 기반 DB validator, `x-db-etag` |
| `plugin-storage/*` | 현재 저장 바이트의 SHA-256, `x-storage-etag` |

클라이언트는 validator를 `If-None-Match`로 보내고, 서버 내용과 일치하면 `304` 응답 후 로컬 사본을 사용합니다.

`/api/read`는 `file-path` 헤더로 서로 다른 데이터를 제공하므로 `Cache-Control: private, no-store`를 적용했습니다. HTTP 캐시 대신 애플리케이션의 IndexedDB 캐시에서 명시적으로 재사용합니다.

## Content-defined chunk delta

사본이 있는 128 KiB 이상인 DB·플러그인 값에는 `POST /api/read-delta`를 사용합니다.

- Gear 기반 content-defined chunking
- 최소 chunk 2 KiB, 최대 chunk 32 KiB
- Boundary mask `8191`
- Manifest 최대 chunk 수 65,536
- Chunk별 SHA-256 비교

고정 offset으로 나누지 않으므로 중간 삽입·삭제로 byte offset이 이동해도 이후 chunk를 재사용할 수 있습니다.

요청 manifest:

```json
{
  "v": 1,
  "size": 4194306,
  "chunks": [
    [8192, "<sha256>"],
    [12031, "<sha256>"]
  ]
}
```

직렬화한 manifest가 4,096자를 초과하면 gzip으로 압축합니다.

응답은 `application/octet-stream` binary packet입니다.

```text
uint32le headerLength
JSON header
literal bytes
```

```json
{
  "v": 1,
  "size": 4194317,
  "sha256": "<reconstructed-value-sha256>",
  "ops": [[0, 0], [1, 1536], [0, 2]]
}
```

- `[0, index]`: 클라이언트 사본의 chunk 재사용
- `[1, length]`: packet 뒤쪽의 literal bytes 소비

서버는 과거 본문 사본이나 revision history를 별도로 보관하지 않습니다. 요청 manifest와 현재 데이터로 delta를 생성하므로 서버 재시작 이후에도 사용할 수 있습니다.

## 응답 선택과 무결성 검증

- Raw delta packet이 전체 값의 80% 미만일 때 부분 전송을 검토합니다.
- `Accept-Encoding`에 gzip이 있으면 gzip 크기도 비교해 전체 응답보다 작은 경우에만 delta를 반환합니다.
- 복원한 전체 데이터의 SHA-256을 서버 값과 비교합니다.
- 잘못된 packet, checksum mismatch, body 수신 중 연결 중단 시 validator 없는 전체 `GET /api/read`를 한 번 수행합니다.
- 구버전 서버가 delta endpoint에 `404/405`를 반환하면 기존 conditional GET으로 fallback합니다.

진단 헤더:

```text
x-read-resource: database | plugin-storage | other
x-read-transfer: full | delta | unchanged
x-read-delta: 1
x-read-full-bytes: <full reconstructed size>
```

`x-read-full-bytes`는 실제 전송량이 아닌 전체 복원 크기입니다.

## Plugin bulk sync

`POST /api/plugin-storage/sync`에 캐시 버전 목록과 `readDelta` capability를 전달합니다.

NDJSON 응답:

- 변경 없음: `[key, null, version]`
- 일반 변경 값: `[key, serializedValue, version]`
- 큰 변경 값이며 client 사본이 존재함: `[key, {"read": true}, version]`

마지막 경우 같은 byte-delta reader로 조회합니다. 삭제된 키는 응답 집합에서 제외하고, stream 완료는 `{"done":true}`로 확인합니다.

V2 동기 storage API를 위해 실행 전에 전체 값을 메모리에 준비하는 동작은 유지했습니다. 이번 변경은 전송량 최적화이며 V2 preload의 메모리 사용 구조는 바꾸지 않습니다.

## 측정과 검증

약 4 MiB의 JSON 문자열 중간에 짧은 문자열을 삽입하고, 실제 Node 서버의 gzip HTTP body를 측정했습니다. 복원 결과는 기대 데이터의 SHA-256과 일치했습니다.

| 요청 | Upload | Download |
| --- | ---: | ---: |
| 전체 읽기 | — | 3,159,040 B |
| 변경 후 delta 읽기 | 16,567 B | 9,533 B |
| Validator 일치 | 비교 목록 | 0 B / `304` |

Synthetic payload 기준이며 HTTP 헤더, 인증, 앱 정적 파일 및 미디어 전송은 제외했습니다. 전체 앱 트래픽 감소율을 보장하지 않습니다. 최초 접속·캐시 유실·대부분의 내용이 바뀐 경우에는 전체 읽기가 필요할 수 있습니다.

배포 준비 시 애플리케이션·통합 테스트 1,698 passed / 3 skipped, 서버 테스트 231 passed. Production build 및 type check 통과.

## 별도 포함 사항과 구현 범위

- 서버 작업 수와 저장 상태를 관찰하는 advisory indicator를 추가했습니다. 조회가 writer session을 claim/revoke하지 않습니다.
- 기존 single-writer lock 및 기기 전환 시 reload는 유지합니다. 실시간 메시지 push 동기화는 추가하지 않았습니다.
- 커스텀 업데이트 대상은 `prina14/pocketrisu-datalite`로 분리했습니다.
- Linux x64 portable에 Node 및 runtime dependencies를 포함합니다.

관련 문서: [사용·측정 안내](data-lite.md), [포터블 설치](datalite-portable.md), [서버 작업 안내 1단계](multi-device-step1.md).
