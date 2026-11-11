#!/usr/bin/env bash
# Ubuntu/systemd: public IPv4 HTTPS for PocketRisu's existing port.
# Installs its own root-owned copy outside the application; no web root access.
set -Eeuo pipefail

CONFIG_DIR=/etc/pocketrisu-https
CONFIG_FILE=$CONFIG_DIR/config
STATE_DIR=/var/lib/pocketrisu-https
HELPER=/usr/local/sbin/pocketrisu-https
SYSTEMD_DIR=/etc/systemd/system
ACME_SERVER=https://acme-v02.api.letsencrypt.org/directory

log() { printf '[PocketRisu HTTPS] %s\n' "$*"; }
die() { log "$*" >&2; return 1; }

usage() {
    cat <<'EOF'
PocketRisu public-IP HTTPS (Ubuntu + systemd)

  sudo bash https.sh                     First setup; asks for public IPv4.
  sudo bash https.sh setup --ip IP       Non-interactive IP selection.
  sudo pocketrisu-https                  Renew if due, restore files, check HTTPS.
  sudo pocketrisu-https status           Show configuration and certificate dates.

Setup options: --ip PUBLIC_IPV4 --email EMAIL --service risu.service --port 6001
Oracle and host firewalls must allow inbound TCP 80 (ACME) and the app port.
No firewall changes, forced certificate renewal, or Tailscale changes are made.
The app is restarted when needed to apply HTTPS. Finish active chats first.
EOF
}

validate_public_ip() {
    python3 - "$1" <<'PY'
import ipaddress, sys
try:
    ip = ipaddress.IPv4Address(sys.argv[1])
    assert ip.is_global and not ip.is_multicast and not ip.is_reserved
except (ValueError, AssertionError):
    sys.exit('Oracle public IPv4 required; private/Tailscale/local/documentation addresses cannot be certified here.')
PY
}

verify_pair() {
    local cert=$1 key=$2 ip=${3:-} cert_pub key_pub
    openssl x509 -in "$cert" -noout -checkend 0 >/dev/null || return 1
    if [[ -n $ip ]]; then openssl x509 -in "$cert" -noout -checkip "$ip" >/dev/null || return 1; fi
    cert_pub=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum) || return 1
    key_pub=$(openssl pkey -in "$key" -pubout -outform DER | sha256sum) || return 1
    [[ $cert_pub == "$key_pub" ]]
}

# Always writes as the service user, including when called by the root helper.
# An application-controlled symlink must never turn this into a root write.
restore_files() {
    local stage=$1 app_dir=$2 ssl cert_tmp key_tmp
    (( EUID != 0 )) || die 'restore-files must run as the non-root application user.'
    [[ -f $app_dir/server/node/server.cjs ]] || die 'WorkingDirectory is not a PocketRisu installation.'
    # Before first issuance the service must still be able to start normally.
    [[ -e $stage/fullchain.pem && -e $stage/privkey.pem ]] || { log 'No staged certificate; existing server configuration retained.'; return; }
    verify_pair "$stage/fullchain.pem" "$stage/privkey.pem" || die 'Staged certificate is expired or its private key does not match; existing files retained.'
    ssl=$app_dir/server/node/ssl/certificate
    if [[ ! -L $ssl/server.crt && ! -L $ssl/server.key ]] &&
        cmp -s "$stage/fullchain.pem" "$ssl/server.crt" && cmp -s "$stage/privkey.pem" "$ssl/server.key"; then
        chmod 600 -- "$ssl/server.crt" "$ssl/server.key"
        printf 'unchanged\n'; return
    fi
    umask 077
    mkdir -p -- "$ssl"
    cert_tmp=$(mktemp "$ssl/.certificate.XXXXXX")
    key_tmp=$(mktemp "$ssl/.key.XXXXXX")
    if ! { install -m 600 -- "$stage/fullchain.pem" "$cert_tmp" &&
        install -m 600 -- "$stage/privkey.pem" "$key_tmp" &&
        mv -fT -- "$key_tmp" "$ssl/server.key" && mv -fT -- "$cert_tmp" "$ssl/server.crt"; }; then
        rm -f -- "$cert_tmp" "$key_tmp"
        die 'Could not restore application certificate files.'; return 1
    fi
    printf 'changed\n'
}

require_root() { (( EUID == 0 )) || die 'Run with sudo. Use --help for examples.'; }

load_config() {
    [[ -f $CONFIG_FILE && ! -L $CONFIG_FILE ]] || die 'Run sudo bash https.sh setup first.'
    [[ $(stat -c %u "$CONFIG_FILE") == 0 ]] || die 'HTTPS configuration must be root-owned.'
    local mode
    mode=$(stat -c %a "$CONFIG_FILE")
    (( (8#$mode & 8#022) == 0 )) || die 'HTTPS configuration must not be writable by group or others.'
    # Only root creates this file; values are written with printf %q.
    source "$CONFIG_FILE"
    validate_public_ip "$PUBLIC_IP"
    [[ $SERVICE =~ ^[A-Za-z0-9_.@:-]+\.service$ ]] || die 'Invalid service name.'
    [[ $PORT =~ ^[1-9][0-9]{0,4}$ ]] && (( PORT <= 65535 )) || die 'Invalid port.'
    [[ $APP_USER != root && -n $APP_USER ]] || die 'A non-root service User is required.'
    id "$APP_USER" >/dev/null
}

find_certbot() {
    local candidate version
    for candidate in /snap/bin/certbot /usr/bin/certbot /usr/local/bin/certbot; do
        [[ -x $candidate ]] || continue
        version=$("$candidate" --version 2>/dev/null) || continue
        if python3 - "$version" <<'PY'
import re, sys
m = re.search(r'(\d+)\.(\d+)', sys.argv[1])
sys.exit(0 if m and tuple(map(int, m.groups())) >= (5, 3) else 1)
PY
        then CERTBOT=$candidate; return; fi
    done
    return 1
}

ensure_tools() {
    local tool
    for tool in python3 openssl curl flock runuser ss install systemctl; do
        command -v "$tool" >/dev/null || die "Missing command: $tool (install prerequisites described in docs/ko/ip-https.md)."
    done
    systemctl show-environment >/dev/null || die 'A running systemd host is required.'
}

check_port80() {
    local listeners
    listeners=$(ss -H -ltn 'sport = :80')
    [[ -z $listeners ]] || die 'TCP 80 is already in use. No service was stopped. Use a webroot/reverse-proxy configuration instead of standalone issuance.'
}

install_units() {
    install -d -m 755 "$SYSTEMD_DIR/$SERVICE.d"
    cat > "$SYSTEMD_DIR/$SERVICE.d/pocketrisu-https.conf" <<EOF
[Service]
SupplementaryGroups=$APP_GROUP
ExecStartPre=$HELPER restore-files
EOF
    cat > "$SYSTEMD_DIR/pocketrisu-https.service" <<EOF
[Unit]
Description=Renew and restore PocketRisu public-IP HTTPS
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$HELPER repair
TimeoutStartSec=600
UMask=0077
EOF
    cat > "$SYSTEMD_DIR/pocketrisu-https.timer" <<'EOF'
[Unit]
Description=Check PocketRisu HTTPS every six hours

[Timer]
OnBootSec=3min
OnUnitActiveSec=6h
RandomizedDelaySec=15min
Unit=pocketrisu-https.service

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
}

setup() {
    PUBLIC_IP= EMAIL= SERVICE=risu.service PORT=6001
    while (( $# )); do
        case $1 in
            --ip|--email|--service|--port)
                (( $# >= 2 )) || die "Missing value for $1"
                case $1 in --ip) PUBLIC_IP=$2;; --email) EMAIL=$2;; --service) SERVICE=$2;; --port) PORT=$2;; esac
                shift 2;;
            *) die "Unknown option: $1";;
        esac
    done
    if [[ -z $PUBLIC_IP ]]; then
        [[ -t 0 ]] || die 'Supply --ip PUBLIC_IPV4 when no terminal is available.'
        read -r -p 'Oracle public IPv4 (not the Tailscale address): ' PUBLIC_IP
    fi
    validate_public_ip "$PUBLIC_IP"
    require_root
    ensure_tools
    [[ $SERVICE =~ ^[A-Za-z0-9_.@:-]+\.service$ ]] || die 'Invalid service name.'
    [[ $PORT =~ ^[1-9][0-9]{0,4}$ ]] && (( PORT <= 65535 )) || die 'Invalid port.'
    [[ $EMAIL != -* && $EMAIL != *$'\n'* ]] || die 'Invalid email.'
    APP_DIR=$(systemctl show "$SERVICE" -p WorkingDirectory --value)
    APP_USER=$(systemctl show "$SERVICE" -p User --value)
    [[ -n $APP_USER && $APP_USER != root && $APP_DIR == /* && -f $APP_DIR/server/node/server.cjs ]] || die 'The selected service must have a non-root User and a PocketRisu WorkingDirectory.'
    [[ $(systemctl show "$SERVICE" -p RootDirectory --value) == '' ]] || die 'RootDirectory services are not supported by this installer.'
    APP_GROUP=$(id -gn "$APP_USER")
    [[ $APP_GROUP =~ ^[A-Za-z0-9_.-]+$ ]] || die 'Unsupported service group name.'
    check_port80
    if ! find_certbot; then
        command -v snap >/dev/null || die 'Install snapd and Certbot 5.3+ first; see docs/ko/ip-https.md.'
        log 'Installing/updating the official Certbot snap.'
        if snap list certbot >/dev/null 2>&1; then snap refresh certbot; else snap install certbot --classic; fi
        find_certbot
    fi
    CERT_NAME=pocketrisu-ip-${PUBLIC_IP//./-}
    install -d -o root -g root -m 700 "$CONFIG_DIR"
    local config_tmp source
    config_tmp=$(mktemp "$CONFIG_DIR/.config.XXXXXX")
    for name in PUBLIC_IP EMAIL SERVICE PORT APP_DIR APP_USER APP_GROUP CERT_NAME; do printf '%s=%q\n' "$name" "${!name}" >> "$config_tmp"; done
    chmod 600 "$config_tmp"
    mv -fT "$config_tmp" "$CONFIG_FILE"
    source=$(readlink -f -- "${BASH_SOURCE[0]}")
    if [[ $source != "$HELPER" ]]; then install -o root -g root -m 755 -- "$source" "$HELPER"; fi
    install -d -o root -g "$APP_GROUP" -m 750 "$STATE_DIR" "$STATE_DIR/generations"
    install_units
    repair
}

local_https_ok() {
    curl --silent --show-error --fail --noproxy '*' --connect-timeout 2 --max-time 5 \
        --connect-to "$PUBLIC_IP:$PORT:127.0.0.1:$PORT" "https://$PUBLIC_IP:$PORT/api/test_auth" >/dev/null 2>&1
}

deploy_certificate() {
    local lineage=/etc/letsencrypt/live/$CERT_NAME stage restored attempt next
    verify_pair "$lineage/fullchain.pem" "$lineage/privkey.pem" "$PUBLIC_IP" || die 'Issued certificate failed IP, validity or key verification. Application files were not changed.'
    stage=$(mktemp -d "$STATE_DIR/generations/cert.XXXXXXXX")
    chown root:"$APP_GROUP" "$stage"
    chmod 750 "$stage"
    install -o root -g "$APP_GROUP" -m 640 "$lineage/fullchain.pem" "$stage/fullchain.pem"
    install -o root -g "$APP_GROUP" -m 640 "$lineage/privkey.pem" "$stage/privkey.pem"
    next=$(mktemp -d "$STATE_DIR/.switch.XXXXXXXX")
    ln -s "$stage" "$next/current"
    mv -fT "$next/current" "$STATE_DIR/current"
    rmdir "$next"
    restored=$(runuser -u "$APP_USER" -- "$HELPER" restore-files "$stage" "$APP_DIR")
    if [[ $restored == changed ]] || ! local_https_ok; then
        log "Applying HTTPS: restarting $SERVICE."
        systemctl restart "$SERVICE"
    fi
    for (( attempt=0; attempt<60; attempt++ )); do
        if local_https_ok; then
            # Keep only two root-owned generations. No application files or ACME lineages are deleted.
            python3 - "$STATE_DIR/generations" "$stage" <<'PY'
import os, shutil, sys
root, current = sys.argv[1:]
old = sorted((p for p in os.scandir(root) if p.is_dir(follow_symlinks=False) and p.path != current), key=lambda p: p.stat().st_mtime, reverse=True)
for entry in old[1:]:
    shutil.rmtree(entry.path)
PY
            log "Ready: https://$PUBLIC_IP:$PORT"
            log 'Repair again with: sudo pocketrisu-https'
            return
        fi
        sleep 1
    done
    die "Certificate was installed, but local HTTPS did not become ready. Check: sudo systemctl status $SERVICE"
}

repair() {
    load_config
    ensure_tools
    find_certbot || die 'Certbot 5.3+ is required. Install/update the official certbot snap, then rerun this command.'
    check_port80
    local account=()
    if [[ -n $EMAIL ]]; then account=(--email "$EMAIL"); else account=(--register-unsafely-without-email); fi
    log "Checking public-IP certificate for $PUBLIC_IP. TCP 80 must be externally reachable."
    "$CERTBOT" certonly --non-interactive --agree-tos --standalone --preferred-challenges http \
        --server "$ACME_SERVER" --preferred-profile shortlived --ip-address "$PUBLIC_IP" \
        --cert-name "$CERT_NAME" --keep-until-expiring "${account[@]}"
    deploy_certificate
}

main() {
    local command=${1:-} source
    case $command in -h|--help|help) usage; return;; esac
    if [[ $command == restore-files ]]; then
        # ExecStartPre uses the app's WorkingDirectory. Root delegates with explicit paths.
        restore_files "${2:-$STATE_DIR/current}" "${3:-$PWD}"
        return
    fi
    require_root
    install -d -o root -g root -m 700 /run/pocketrisu-https
    exec 9>/run/pocketrisu-https/lock
    flock -n 9 || die 'Another HTTPS operation is already running. Try again after it finishes.'
    # Running the helper shipped with a newer portable also refreshes the
    # root-owned installed copy, without resetting the saved configuration.
    if [[ -f $CONFIG_FILE && ( -z $command || $command == repair ) ]]; then
        source=$(readlink -f -- "${BASH_SOURCE[0]}")
        if [[ $source != "$HELPER" ]]; then install -o root -g root -m 755 -- "$source" "$HELPER"; fi
    fi
    case $command in
        '') if [[ -f $CONFIG_FILE ]]; then repair; else setup; fi;;
        setup) shift; setup "$@";;
        repair) repair;;
        status)
            load_config
            log "Address: https://$PUBLIC_IP:$PORT; service: $SERVICE; directory: $APP_DIR"
            if [[ -f $STATE_DIR/current/fullchain.pem ]]; then openssl x509 -in "$STATE_DIR/current/fullchain.pem" -noout -dates -ext subjectAltName; fi
            systemctl list-timers pocketrisu-https.timer --no-pager;;
        *) usage; die "Unknown command: $command";;
    esac
    if [[ -z $command || $command == setup || $command == repair ]]; then
        # An overdue OnBootSec may fire immediately when first enabled.
        # Release the completed operation's lock before starting the timer.
        flock -u 9
        systemctl enable --now pocketrisu-https.timer
        log 'Automatic certificate check enabled.'
    fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    report_error() {
        if [[ -f $CONFIG_FILE && -x $HELPER ]]; then
            printf '[PocketRisu HTTPS] Failed. Fix the error above, then run: sudo pocketrisu-https\n' >&2
        else
            printf '[PocketRisu HTTPS] Setup failed. Fix the error above, then rerun: sudo bash ./https.sh\n' >&2
        fi
    }
    trap report_error ERR
    main "$@"
fi
