# 데이터 버전 관리: revision 기반 최신 여부 확인

이 문서는 `v1.17.0-datalite.1` 이후 main에 추가한 데이터 버전 관리 작업입니다. 앱 배포 버전 확인과 구분합니다. 로딩 UI, 플러그인 초기화, 저장권한, 기기 전환 정책은 변경하지 않습니다.

## 서버 메타데이터

- SQLite에 `datalite_read_revisions(key, token)`을 추가합니다. 기존 KV 본문과 `.bin` 백업 형식은 바꾸지 않습니다.
- 대상은 `database/database.bin`과 `plugin-storage/*`입니다.
- SQLite INSERT/UPDATE/DELETE 트리거로 본문 변경과 같은 transaction 안에서 버전을 갱신합니다. 개별 저장 함수뿐 아니라 복원·가져오기·SQL 복사 경로와 chunked DB marker 갱신도 관찰합니다. transaction이 rollback되면 버전 변경도 rollback됩니다.
- 시간값을 비교하지 않습니다. 쓰기마다 새 random token을 부여하며, 같은 내용을 다시 저장해도 보수적으로 새 버전을 부여할 수 있습니다.
- 프로세스 시작마다 epoch를 바꿉니다. 재시작 후에는 같은 본문이더라도 최초 한 번 내용 validator를 다시 확인하므로, 다른 실행의 오래된 토큰이 잘못 일치하지 않습니다.
- DB token에는 인메모리 view 식별자와 기존 DB write validator도 포함합니다. probe 전에 pending persist를 flush하고, 아직 디스크 저장을 기다리는 변경이나 cache invalidation을 놓치지 않도록 합니다.

## 개별 읽기

응답 본문과 함께 받은 `x-read-revision`을 IndexedDB 메타데이터에 보관합니다. 다음 읽기에서는 chunk manifest를 만들기 전에 다음 요청을 보냅니다.

```http
GET /api/read
file-path: <기존 hex key>
x-read-check-only: 1
if-read-revision: <저장된 token>
```

- 같음: `304`, 본문 없음. DB 본문 읽기·인코딩·MD5/SHA 계산·chunk manifest 생성 및 업로드를 생략합니다.
- 다름: `200`, 본문 없음, `x-read-version-check: 1`. 이어서 기존 conditional read 또는 byte delta로 실제 본문을 확인합니다.
- 실제로 받은 본문이나 content validator가 확인된 `304` 응답의 token만 캐시에 반영합니다. probe에서 관찰한 token만으로 기존 본문을 최신으로 표시하지 않습니다.
- 서버가 probe 기능을 모르면 기존 정상 응답을 그대로 사용합니다. 서버 오류를 로컬 데이터로 감추지 않습니다.

revision만 바뀌고 내용 해시는 같을 때는 큰 캐시 본문을 다시 쓰지 않고 메타데이터만 갱신합니다. 기존 IndexedDB 구조를 유지하고 새 필드는 optional로 처리하므로 이전 사본은 최초 한 번 기존 경로로 확인합니다.

## 플러그인 전체 동기화

`POST /api/plugin-storage/sync`에 optional `revisions: [[key, token], ...]`을 추가했습니다. metadata 목록의 버전이 같으면 값 읽기와 SHA-256 계산 없이 다음 행을 돌려줍니다.

```json
["key", null, null, "revision-token"]
```

큰 변경 값은 기존 delta reader로 위임하고, 작은 변경 값과 최초 읽기는 기존 본문+SHA 처리 후 revision을 함께 전달합니다. 삭제된 키는 목록에서 제외합니다. revision capability가 없는 구버전 클라이언트에는 기존 3열 NDJSON 형식을 유지합니다.

## 검증 범위

같은 timestamp의 저장, SQL 복원, transaction rollback, 삭제 후 같은 이름·내용으로 재생성, 서버 epoch 변경, chunked marker 재기록을 검증합니다. 실제 서버에서는 메인 DB 변경과 backup import, debounce 중인 patch, 인증, plugin bulk revision 응답을 확인합니다. 클라이언트에서는 probe만으로 변경 없는 큰 사본을 재사용하는 것과 구버전 서버 fallback, IndexedDB metadata만 갱신하는 것을 확인합니다.

변경 없는 경우의 검증 비용을 줄이는 작업이며, 페이지 재시작 후 DB 디코딩·플러그인 초기화 시간을 없애는 작업은 아닙니다. 전체 초기 로딩 시간 개선은 후속 범위입니다.
