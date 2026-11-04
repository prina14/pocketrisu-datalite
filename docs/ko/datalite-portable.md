# PocketRisu DataLite 1 포터블

- 버전: **v1.17.0-datalite.1**
- 원본 기반: PocketRisu v1.17.0
- 포함 기능: 재접속 캐시, 큰 DB·플러그인 값의 부분 전송, 서버 작업 중 안내 1단계
- 저장권한과 기기 전환 재로딩은 기존 동작입니다. 이번 배포에서 다음 단계를 추가하지 않습니다.

## Oracle 무료 서버

확인된 대상은 **Ubuntu 26.04 x86_64, RAM 951 MiB, 스왑 없음**입니다. 남은 메모리가 179 MiB인 상태에서는 직접 빌드를 권장하지 않습니다. 이 포터블에는 Node.js와 실행용 의존성 및 빌드된 앱이 들어 있으므로 서버에서 npm/pnpm 설치나 빌드가 필요 없습니다.

서버 실행에는 메모리가 필요합니다. 빈 DB로 테스트한 RSS는 약 81 MiB였지만, 캐릭터·채팅·플러그인 저장소에 따라 증가합니다. 기존 서버를 중지한 뒤 새 서버를 시작하세요.

## 설치·이전

`PocketRisu-v1.17.0-datalite.1-linux-x64.tar.gz`와 같은 이름의 `.sha256` 파일을 PC에 다운로드합니다. Windows PowerShell에서 업로드하는 예입니다. IP와 SSH 키 경로는 본인 값으로 바꿉니다.

```powershell
scp -i "C:\SSH키\oracle.key" .\PocketRisu-v1.17.0-datalite.1-linux-x64.tar.gz .\PocketRisu-v1.17.0-datalite.1-linux-x64.tar.gz.sha256 ubuntu@서버IP:~/
```

서버에 SSH로 접속하고 실행합니다.

```bash
cd ~
sha256sum -c PocketRisu-v1.17.0-datalite.1-linux-x64.tar.gz.sha256
tar -xzf PocketRisu-v1.17.0-datalite.1-linux-x64.tar.gz
```

**기존 PocketRisu를 중지하고 `save/`, `backups/`를 별도 위치에 백업한 뒤**, 두 폴더를 새 설치 폴더 안으로 복사합니다. 원본 설치 폴더는 되돌리기에 쓸 수 있도록 보관합니다. 사용자 지정 백업 경로를 사용했다면 그 경로도 보존하세요.

새 폴더에서 실행합니다.

```bash
cd ~/PocketRisu-v1.17.0-datalite.1-linux-x64
./start.sh
```

첫 실행은 로그를 볼 수 있도록 위처럼 실행해 정상 여부를 확인합니다. 기본 포트는 6001이며 기존과 같은 서버·포트라면 기존 접속 주소를 쓸 수 있습니다. 시작할 때 `EADDRINUSE`가 나오면 이전 서버나 서비스가 아직 포트를 사용 중인 것입니다.

SSH를 닫은 뒤에도 실행하려면 먼저 `Ctrl+C`로 종료한 다음 다음과 같이 실행할 수 있습니다.

```bash
nohup ./start.sh > server.log 2>&1 < /dev/null &
echo $! > server.pid
```

이 방식은 서버 재부팅 시 자동 시작하지 않습니다. 이미 systemd 서비스를 사용하고 있다면 중복 실행하는 대신 그 서비스의 `WorkingDirectory`와 `ExecStart`를 새 폴더로 변경합니다.

## systemd 신규 설치 예

SSH 계정이 `ubuntu`이고 설치 경로가 위 예와 같을 때입니다. 기존 PocketRisu 서비스가 있다면 먼저 중지합니다.

```ini
[Unit]
Description=PocketRisu DataLite
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/PocketRisu-v1.17.0-datalite.1-linux-x64
ExecStart=/home/ubuntu/PocketRisu-v1.17.0-datalite.1-linux-x64/start.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

위 내용을 `/etc/systemd/system/pocketrisu-datalite.service`에 저장한 뒤 실행합니다.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pocketrisu-datalite
sudo systemctl status pocketrisu-datalite
```

## 이후 커스텀 업데이트

업데이트 대상은 `prina14/pocketrisu-datalite`입니다. 원본 PocketRisu 업데이트로 커스텀 코드가 교체되지 않도록 분리했습니다. 공개된 커스텀 Release가 있어야 앱 내 업데이트 및 `./update.sh`로 받을 수 있습니다. 비공개 저장소나 Draft 릴리스는 로그인 후 포터블을 내려받아 수동 교체합니다.

GitHub의 `v*-datalite.*` 태그는 Linux x64 포터블만 빌드하며, Docker 배포는 실행하지 않습니다. 기존 워크플로 설정대로 릴리스는 **Draft**로 생성됩니다. 저장소 소유자가 검토 후 공개할 수 있습니다. `Source code (zip)`은 실행 파일이 포함된 포터블과 다릅니다.
