# PocketRisu DataLite

**PocketRisu(포켓리스)를 기반으로, 모바일 웹 접속 시 데이터 사용량을 줄이기 위해 만든 커스텀 버전입니다.**

서버 한 대에 PC·모바일로 접속하는 개인 사용 환경을 대상으로 합니다. 재접속할 때 메인 DB와 플러그인 저장소를 반복 다운로드하는 비용을 줄이는 데 초점을 맞췄습니다.

> A custom build of PocketRisu focused on reducing mobile-web data transfer through persistent caching, conditional reads, and content-defined chunk synchronization.

- **커스텀 버전:** `v1.17.0-datalite.6` — PocketRisu DataLite 6
- **원본 기반:** [PocketRisu v1.17.0](https://github.com/PocketRisu/PocketRisu), commit `40851fc9831856a36cb5c14799c1f501f32dc133`
- **원본과의 관계:** PocketRisu의 커스텀 빌드이며, 원본 프로젝트의 공식 배포판과 구분됩니다.
- **라이선스:** [GPL-3.0](LICENSE)

## 데이터 절약을 위해 바꾼 부분

| 변경 | 동작 |
| --- | --- |
| Persistent cache | IndexedDB에 DB·플러그인 데이터 사본과 validator를 보관합니다. |
| Conditional read | 서버와 내용이 같으면 `304` 응답 후 로컬 사본을 재사용합니다. |
| Chunk delta | 큰 값의 일부가 바뀌면 content-defined chunk 단위로 필요한 부분만 받아 복원합니다. |
| Plugin bulk sync | V2 사전 로딩과 V3 개별·전체 읽기에서 중복 전송을 줄입니다. |
| Integrity check | 복원한 전체 값의 SHA-256을 검증하고, 실패·전송 중단 시 전체 읽기로 복구합니다. |

128 KiB 이상인 값에 사본이 있으면 `/api/read-delta`를 사용합니다. 조각은 최소 2 KiB, 최대 32 KiB이며, 비교 목록도 필요에 따라 gzip으로 압축합니다. 서버에 이전 본문 사본을 쌓아 두는 방식이 아니므로 서버 재시작 이후에도 사용할 수 있습니다.

별도로 켜는 모드 버튼 없이 적용됩니다. 기존 서버 저장 형식과 `.bin` 백업 형식은 유지합니다.

## 전송량 측정 예시

실제 Node 서버에 테스트용 JSON 문자열을 저장한 뒤 중간에 짧은 내용을 추가하고, gzip HTTP body 크기를 측정했습니다.

| 요청 | Upload | Download |
| --- | ---: | ---: |
| 전체 읽기 | — | 3,159,040 B |
| 수정 후 부분 동기화 | 16,567 B | 9,533 B |
| 내용이 같은 재접속 | 비교 목록 | 0 B / `304` |

**특정 테스트 데이터의 결과이며 전체 앱 트래픽 감소율을 보장하는 수치는 아닙니다.** HTTP 헤더·인증·정적 앱 파일·이미지 등의 통신은 제외했습니다. 최초 접속, 캐시 삭제, 새 앱 빌드, 미디어 로딩, 대부분의 내용이 바뀐 경우에는 더 많은 데이터를 받을 수 있습니다.

메인 DB·플러그인 전송 캐시는 최대 512 MiB를 보관합니다. 채팅은 열거나 서버 저장에 성공한 내용을 메시지 수·용량에 관계없이 기본 캐시하며, 브라우저 저장 한도에 걸리면 오래 사용하지 않은 채팅 사본부터 정리합니다. 사본이 없거나 캐시를 사용할 수 없으면 네트워크 읽기로 동작합니다. V2 플러그인은 기존 동기 API를 유지하기 위해 실행 전 전체 값을 메모리에 준비합니다. 전송량 최적화가 V2의 메모리 구조까지 바꾸는 것은 아닙니다.

## 적용 범위

- 추가 기능으로 서버 작업 중 상태를 알려주는 비차단 안내가 포함됩니다.
- 기존 single-writer lock과 기기 전환 시 재로딩 동작은 유지합니다.
- 메시지 단위의 실시간 멀티 디바이스 동기화는 이번 버전의 구현 범위가 아닙니다.
- 커스텀 업데이트 대상은 이 저장소입니다. 공개된 커스텀 Release가 있어야 자동 업데이트로 받을 수 있습니다.

## 설치·업데이트 및 개발 문서

- [Linux x64 포터블 / Oracle 서버 설치 안내](docs/ko/datalite-portable.md)
- [데이터 절약 기능과 확인 방법](docs/ko/data-lite.md)
- [모든 채팅의 기본 캐시와 저장 후 갱신](docs/ko/chat-cache.md)
- [메인 화면의 캐시 사용량 표시](docs/ko/cache-usage.md)
- [최적화 점검 보고서와 수정 우선순위](docs/ko/optimization-audit-2026-11-09.md)
- [1GB 서버의 메모리 최적화](docs/ko/server-memory.md)
- [개발자용 기술 패치 노트](docs/ko/datalite-patch-notes.md)
- [기기 전환 개선 1단계: 서버 작업 안내](docs/ko/multi-device-step1.md)
- [커스텀 Releases](https://github.com/prina14/pocketrisu-datalite/releases)

포터블에는 Node.js와 실행용 의존성, 빌드된 앱이 포함됩니다. 설치 서버에서 프런트엔드를 다시 빌드할 필요가 없습니다. 기존 설치 경로와 자동실행 설정을 유지할 수 있으며, 업데이트 전 서버를 중지하고 `save/`·`backups/`를 보존하세요. GitHub의 `Source code (zip)`은 포터블 실행 패키지와 다릅니다.

## 원본 프로젝트와 문의

- 이 커스텀 버전의 문제·제안: [DataLite Issues](https://github.com/prina14/pocketrisu-datalite/issues)
- 기반 프로젝트: [PocketRisu](https://github.com/PocketRisu/PocketRisu)
- PocketRisu의 기반 프로젝트: [RisuAI](https://github.com/kwaroran/RisuAI)
- 원본 PocketRisu 기능·설치 문서: [upstream README](https://github.com/PocketRisu/PocketRisu#readme)

원본 프로젝트의 코드·자산 및 기여자 크레딧과 GPL-3.0 라이선스를 유지합니다.
