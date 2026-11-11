import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { get as httpsGet } from 'node:https'
import { checkServerIdentity } from 'node:tls'
import { spawnServer } from '../../test/compat/helpers/spawnServer'

const script = path.resolve('https.sh')
const shell = (source: string, ...args: string[]) => spawnSync('bash', ['-c', 'source "$1"; shift; ' + source, 'test-shell', script, ...args], { encoding: 'utf8' })

describe.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('public IP HTTPS setup and recovery', () => {
    let temp: string
    let stage: string
    beforeAll(() => {
        temp = mkdtempSync(path.join(os.tmpdir(), 'risu-ip-https-'))
        stage = path.join(temp, 'certificate source')
        mkdirSync(stage)
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=fixture', '-addext', 'subjectAltName=IP:8.8.8.8', '-keyout', path.join(stage, 'privkey.pem'), '-out', path.join(stage, 'fullchain.pem')], { stdio: 'pipe' })
    })
    afterAll(() => { rmSync(temp, { recursive: true, force: true }) })

    test('shell parses and help has no setup side effects', () => {
        expect(spawnSync('bash', ['-n', script]).status).toBe(0)
        const result = spawnSync('bash', [script, '--help'], { encoding: 'utf8' })
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('sudo pocketrisu-https')
        expect(result.stdout).toContain('TCP 80')
    })

    test.each(['127.0.0.1', '10.0.0.1', '100.64.0.1', '192.168.0.1', '203.0.113.1', '224.0.0.1', '::1', '8.8.8.8; touch nope'])('rejects a non-public IPv4 or shell input: %s', ip => {
        const result = shell('validate_public_ip "$1"', ip)
        expect(result.status).not.toBe(0)
    })

    test('public IPs validate and certificate identity is checked separately', () => {
        expect(shell('validate_public_ip "$1"', '8.8.8.8').status).toBe(0)
        expect(shell('verify_pair "$1/fullchain.pem" "$1/privkey.pem" "$2"', stage, '8.8.8.8').status).toBe(0)
        expect(shell('verify_pair "$1/fullchain.pem" "$1/privkey.pem" "$2"', stage, '1.1.1.1').status).not.toBe(0)
    })

    test('restores a lost certificate before startup, preserves key permissions and skips identical copies', () => {
        const app = path.join(temp, 'app with spaces')
        mkdirSync(path.join(app, 'server/node'), { recursive: true })
        writeFileSync(path.join(app, 'server/node/server.cjs'), '// fixture')
        const run = () => shell('restore_files "$1" "$2"', stage, app)
        const first = run()
        expect(first.status, first.stderr).toBe(0)
        expect(first.stdout.trim()).toBe('changed')
        const ssl = path.join(app, 'server/node/ssl/certificate')
        expect(readFileSync(path.join(ssl, 'server.key'))).toEqual(readFileSync(path.join(stage, 'privkey.pem')))
        expect(statSync(path.join(ssl, 'server.key')).mode & 0o777).toBe(0o600)
        chmodSync(path.join(ssl, 'server.key'), 0o644)
        expect(run().stdout.trim()).toBe('unchanged')
        expect(statSync(path.join(ssl, 'server.key')).mode & 0o777).toBe(0o600)
        rmSync(path.join(app, 'server/node/ssl'), { recursive: true })
        expect(run().stdout.trim()).toBe('changed')
    })

    test('a bad stage never overwrites a working certificate; absent stage allows normal startup', () => {
        const app = path.join(temp, 'valid app')
        const ssl = path.join(app, 'server/node/ssl/certificate')
        mkdirSync(ssl, { recursive: true })
        writeFileSync(path.join(app, 'server/node/server.cjs'), '// fixture')
        writeFileSync(path.join(ssl, 'server.key'), 'original-key')
        writeFileSync(path.join(ssl, 'server.crt'), 'original-certificate')
        const bad = path.join(temp, 'invalid stage')
        mkdirSync(bad)
        writeFileSync(path.join(bad, 'privkey.pem'), 'invalid')
        writeFileSync(path.join(bad, 'fullchain.pem'), readFileSync(path.join(stage, 'fullchain.pem')))
        expect(shell('restore_files "$1" "$2"', bad, app).status).not.toBe(0)
        expect(readFileSync(path.join(ssl, 'server.key'), 'utf8')).toBe('original-key')
        expect(readFileSync(path.join(ssl, 'server.crt'), 'utf8')).toBe('original-certificate')
        expect(shell('restore_files "$1" "$2"', path.join(temp, 'absent'), app).status).toBe(0)
    })

    test('replaces destination symlinks without changing the file they pointed at', () => {
        const app = path.join(temp, 'symlink app')
        const ssl = path.join(app, 'server/node/ssl/certificate')
        mkdirSync(ssl, { recursive: true })
        writeFileSync(path.join(app, 'server/node/server.cjs'), '// fixture')
        const victim = path.join(temp, 'do-not-change')
        writeFileSync(victim, 'retained')
        symlinkSync(victim, path.join(ssl, 'server.key'))
        expect(shell('restore_files "$1" "$2"', stage, app).status).toBe(0)
        expect(readFileSync(victim, 'utf8')).toBe('retained')
    })

    test('root configuration refuses untrusted ownership before sourcing', () => {
        const config = path.join(temp, 'untrusted config')
        const marker = path.join(temp, 'must-not-run')
        writeFileSync(config, 'touch "' + marker + '"\n')
        chmodSync(config, 0o600)
        const result = shell('CONFIG_FILE=$1; load_config', config)
        expect(result.status).not.toBe(0)
        expect(existsSync(marker)).toBe(false)
    })

    test('service integration restores before startup as the existing service user and uses a bounded timer', () => {
        const units = path.join(temp, 'units')
        mkdirSync(units)
        const result = shell('SYSTEMD_DIR=$1; SERVICE=risu.service; APP_GROUP=ubuntu; systemctl(){ :; }; install_units', units)
        expect(result.status, result.stderr).toBe(0)
        const dropin = readFileSync(path.join(units, 'risu.service.d/pocketrisu-https.conf'), 'utf8')
        expect(dropin).toContain('ExecStartPre=/usr/local/sbin/pocketrisu-https restore-files')
        expect(dropin).not.toContain('User=root')
        expect(dropin).not.toContain('ExecStart=')
        expect(readFileSync(path.join(units, 'pocketrisu-https.timer'), 'utf8')).toContain('OnUnitActiveSec=6h')
    })

    test('a busy port 80 is reported without stopping another service', () => {
        const result = shell('ss(){ printf "LISTEN\n"; }; systemctl(){ touch "$1"; }; check_port80')
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('TCP 80 is already in use')
    })

    test('issuance failure does not deploy files or restart the application', () => {
        const marker = path.join(temp, 'must-not-deploy')
        const result = shell(`DEPLOY_MARKER=$1; load_config(){ PUBLIC_IP=8.8.8.8; EMAIL=; CERT_NAME=fixture; };
            ensure_tools(){ :; }; find_certbot(){ CERTBOT=/bin/false; }; check_port80(){ :; };
            deploy_certificate(){ touch "$DEPLOY_MARKER"; }; repair`, marker)
        expect(result.status).not.toBe(0)
        expect(existsSync(marker)).toBe(false)
    })

    test('the actual Node server starts with restored files and serves verified HTTPS', async () => {
        const server = await spawnServer({ seedSave: async saveDir => {
            const app = path.dirname(saveDir)
            mkdirSync(path.join(app, 'server/node'), { recursive: true })
            writeFileSync(path.join(app, 'server/node/server.cjs'), '// installation marker')
            const restored = shell('restore_files "$1" "$2"', stage, app)
            expect(restored.status, restored.stderr).toBe(0)
        } })
        try {
            const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                const request = httpsGet({ hostname: '127.0.0.1', port: server.port, path: '/api/test_auth',
                    ca: readFileSync(path.join(stage, 'fullchain.pem')),
                    checkServerIdentity: (_host, certificate) => checkServerIdentity('8.8.8.8', certificate),
                }, result => {
                    let body = ''
                    result.on('data', chunk => { body += chunk })
                    result.on('end', () => resolve({ status: result.statusCode!, body }))
                    result.on('error', reject)
                })
                request.on('error', reject)
                request.setTimeout(5000, () => request.destroy(Error('HTTPS timeout')))
            })
            expect(response.status).toBe(200)
            expect(JSON.parse(response.body).status).toBe('incorrect')
        } finally { await server.cleanup() }
    })
})
