# 공인 IP:6001 HTTPS 자동 설정·복구

Ubuntu의 기존 `risu.service`와 설치 폴더를 유지하면서, `https://공인IP:6001`로 직접 접속합니다.
웹 버튼을 추가하는 변경이 아니라 서버에서 한 번 실행하는 설정 명령입니다.
Tailscale의 `*.ts.net` 인증서와 별도로 Oracle **공인 IPv4**용 인증서를 발급합니다.
프로그램 빌드나 Node.js 재설치는 필요하지 않습니다.

## 처음 한 번

Oracle 보안 목록/NSG와 서버 방화벽에서 **인바운드 TCP 80과 6001**에 접근할 수 있어야 합니다.
80은 Let's Encrypt의 HTTP-01 인증 확인에 사용하며, 인증서 갱신 때도 열려 있어야 합니다.
이 스크립트는 Oracle 설정이나 기존 방화벽 규칙을 자동 변경하지 않습니다.
80을 다른 웹 서버가 사용 중이면 중지하지 않고 안내 후 종료합니다. 그 경우 webroot 등의 별도 구성이 필요합니다.

진행 중인 채팅을 마친 뒤, 업데이트된 기존 설치 폴더에서 실행합니다.

```bash
cd /home/ubuntu/Risu-AI/PocketRisu-v1.15.0-linux-x64
sudo bash ./https.sh
```

최초에는 Oracle 공인 IPv4를 입력합니다. 입력을 미리 지정할 수도 있습니다.

```bash
sudo bash ./https.sh setup --ip 본인의_공인IP
```

기본 서비스는 `risu.service`, 접속 포트는 6001입니다. 실제 서비스의 `User`와 `WorkingDirectory`를
조회하며, 원래 `ExecStart`·설치 경로·포트를 바꾸지 않습니다. 다른 서비스명은 `--service 이름.service`,
다른 접속 포트는 `--port 번호`로 지정합니다. 이 옵션은 리수 실행 포트를 변경하지 않으므로 실제 포트와 같아야 합니다.

- Certbot 5.3+의 standalone IP 발급과 `shortlived` 프로필을 사용합니다.
- 적합한 Certbot이 없으면 공식 certbot snap을 설치/업데이트합니다. Ubuntu에 snap이 필요합니다.
- 기본 도구가 누락됐다면 `sudo apt update` 후 `sudo apt install ca-certificates curl openssl python3 util-linux iproute2 snapd`로 설치합니다.
- 이메일은 선택 사항입니다. 지정하려면 최초 명령에 `--email 본인메일주소`를 추가합니다.
  지정하지 않으면 이메일 없이 ACME 계정을 등록합니다. 발급 명령은 Let's Encrypt 이용약관에 동의하여 진행합니다.
- 공인 IPv4에 대해 인증서가 발급되므로 발급 대상 IP는 공개 인증서 투명성 로그에 남을 수 있습니다.

성공하면 마지막에 나오는 **`https://공인IP:6001`**로 접속합니다.
리수가 HTTP에서 HTTPS로 바뀌므로 기존 `http://127.0.0.1:6001`을 대상으로 한 Tailscale Serve 설정은
이후 같은 방식으로 연결되지 않을 수 있습니다. 스크립트는 Tailscale 설정을 변경하지 않습니다.

## 이후에는 명령 하나

```bash
sudo pocketrisu-https
```

저장해 둔 IP와 서비스 설정을 사용합니다. 인증서가 갱신 시점이면 갱신하고, 리수 쪽 파일이 없어졌다면
복원합니다. 인증서가 같고 HTTPS가 정상이면 리수를 재시작하지 않습니다. 강제 재발급 옵션은 사용하지 않습니다.
발급 실패 시 기존 리수 프로세스를 중지하거나 기존 인증서 파일을 교체하지 않습니다.

새 버전의 설정 스크립트를 적용하려면 설치 폴더에서 `sudo bash ./https.sh`를 실행합니다.
저장된 설정을 사용하고 루트 소유 설치본도 갱신합니다.

상태 확인:

```bash
sudo pocketrisu-https status
sudo systemctl status pocketrisu-https.timer --no-pager
```

오류 기록:

```bash
sudo journalctl -u pocketrisu-https.service -n 50 --no-pager
```

공인 IP가 바뀌면 새 IP를 지정해 `setup --ip 새공인IP`를 다시 실행합니다. IP용 인증서는 새 주소로
발급해야 하며 브라우저 접속 주소도 바뀝니다. 이 도구는 공인 IP 변경을 자동 탐지하지 않습니다.

## 업데이트 이후 유지 방식

- 인증서 원본: `/etc/letsencrypt`.
- HTTPS 도구 설정: `/etc/pocketrisu-https/config` — root 전용.
- 검증된 복원용 사본: `/var/lib/pocketrisu-https/current` — root가 관리하고 서비스 사용자 그룹만 읽습니다.
- 복구 명령: `/usr/local/sbin/pocketrisu-https` — root 소유, 리수에서 웹 요청으로 실행하지 않습니다.
- 서비스 시작 전 복원: `/etc/systemd/system/risu.service.d/pocketrisu-https.conf`.
- 갱신 확인: `pocketrisu-https.timer`가 부팅 후와 약 6시간 간격으로 실행합니다.

현재 리수가 읽는 `server/node/ssl/certificate/server.crt`·`server.key`를 서비스 시작 전에 복원합니다.
파일이 없어져도 리수 업데이트 경로 밖의 원본과 systemd 설정은 유지됩니다. 복원은 **서비스 사용자 권한**으로
수행하며 개인 키 파일은 0600으로 보관합니다. root가 앱에서 바꿀 수 있는 경로에 직접 키를 쓰지 않습니다.
인증서의 IP·만료·키 일치를 확인하고, 적용 후에는 공인 IP 인증서를 검증하며 루프백 HTTPS 연결을 확인합니다.
이 검사는 외부 6001 방화벽까지 확인하는 검사는 아니므로 휴대폰에서도 실제 접속을 확인해야 합니다.

인증서 적용이 필요하면 기존 서비스를 재시작하므로 진행 중인 요청은 끊길 수 있습니다.
복구용 사본은 최근 두 세대만 유지하며 DB·채팅·설정·백업 데이터는 수정하지 않습니다.
`risu.service`는 비-root 사용자와 실제 설치 폴더의 `WorkingDirectory`를 사용해야 합니다.
서비스의 별도 파일 시스템 격리 설정이 복원 도구 실행·키 읽기를 막는 경우 해당 정책 조정이 필요할 수 있습니다.

## 검증 범위

공인 IP 판정, 모의 인증서의 IP·키 검증, 파일 유실 후 복원, 인증서 일치 시 재복사 생략,
잘못된 키 보존, 목적지 심볼릭 링크 안전성, root 설정 파일 신뢰 검사, 발급 실패 시 미적용,
서비스 시작 전 복원과 타이머 구성을 임시 디렉터리에서 시험합니다.
실제 Oracle 서버의 방화벽 변경·공인 인증서 발급·재시작은 이 개발 환경에서 수행하지 않았습니다.

[Certbot 공식 IP 지원 변경 기록](https://github.com/certbot/certbot/blob/main/certbot/CHANGELOG.md)
