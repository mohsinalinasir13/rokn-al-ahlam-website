# Rokn enquiry relay: deployment package

Status: **prepared, not deployed.** Nothing here has been run on the VM, no DNS has been changed and Company OS has not been touched.

```
Rokn website ── HTTPS ──> lead.roknalahlam.com (Caddy, existing Company OS container)
                              │  only POST/OPTIONS /api/enquiry; body <= 32 KB; X-Forwarded-For overwritten
                              ▼
                         rokn-relay  (this package; no host port; on Company OS's private network)
                              │  HMAC-signed request over the private Docker network (never the Internet)
                              ▼
                         http://app:8000/api/v1/leads/website  →  central Prospect record
```

| File | Purpose |
|---|---|
| `Dockerfile` | Relay image: `node:22-alpine`, unprivileged user, no dependencies, health check that also fails if the secret/URL is missing |
| `docker-compose.relay.yml` | Runs it: read-only filesystem, all capabilities dropped, no-new-privileges, 128 MB / 0.25 CPU / 64 PIDs, log rotation, **no published ports** |
| `relay.env.example` | Variable names only; the secret is blank |
| `Caddyfile.lead` | Site block for `lead.roknalahlam.com` |
| `company-os-caddyfile.patch` | The same block as a patch against Company OS `infra/caddy/Caddyfile` (`origin/main`); dry-run applies cleanly |

## What was verified before this package was written

Verified locally against Company OS code that is **byte-identical to `origin/main`** for the intake (`app/domain/leads.py`, `app/services/leads.py`, `app/core/webhook_security.py`): the relay's signature equals Company OS's verification (also unit-tested against Python's HMAC); a real enquiry creates exactly one Prospect; retrying the same lead id creates no duplicate; a wrong secret is rejected and stores nothing; Company OS being down fails closed; relay logs contain no customer data; strict origin allow-list (including look-alike domains); rate limiting cannot be evaded with a spoofed `X-Forwarded-For`; the exact file layout the Dockerfile produces runs correctly; the compose file parses with no host ports.

**Not verified locally (needs the VM):** the Docker image build, `docker compose up`, and the Caddy block. Docker Desktop's engine would not start on the development PC, so section 3.4 makes these checks mandatory *before* anything is started or reloaded. Each is non-destructive: a failed build or a rejected Caddy config leaves production exactly as it was.

## 1. Decisions and prerequisites (need Mohsin)

1. **DNS:** an `A` record `lead` → `84.235.246.14` for `roknalahlam.com` (Hostinger DNS). Add only that record; leave MX/SPF/DKIM/DMARC and everything else unchanged. `roknalahlam.com` has no CAA record, so Let's Encrypt is allowed. Lower the TTL to 300 first. Note that `84.235.246.14` is an *ephemeral* Oracle IP (see Company OS notes): if the VM is ever stopped or recreated, both `os.` and `lead.` break until the records are updated.
2. **Approval to push** the website branch, so the VM can clone the exact reviewed commit (or use the tarball fallback in 3.2).
3. **The signing secret** is never typed, pasted or printed: section 3.3 copies it server-side from Company OS's own configuration.
4. **Deployment authorisation** for each of sections 3.5 and 3.6.

## 2. Configuration reference

| Variable | Value | Notes |
|---|---|---|
| `COMPANY_OS_INTAKE_URL` | `http://app:8000/api/v1/leads/website` | Private network hop, no TLS needed, still signed |
| `COMPANY_OS_WEBHOOK_SECRET` | *(secret, server-side only)* | Same value as `WEBSITE_WEBHOOK_SECRET` in `/opt/company-os/.env.production`. Company OS supports a single shared website secret, so rotating it means updating every consumer |
| `ALLOWED_ORIGINS` | `https://roknalahlam.com,https://www.roknalahlam.com` | Any other origin gets 403 and no CORS headers. Drop `www` if unused |
| `TRUST_PROXY` | `1` | Safe only because Caddy is the sole proxy and **overwrites** `X-Forwarded-For`; the relay uses the last entry, which the proxy vouches for |
| `RATE_LIMIT_PER_MIN` | `10` | Per visitor IP, in memory, per relay process |
| `UPSTREAM_TIMEOUT_MS` | `8000` | Company OS wait; the site shows a clear failure and keeps the entered data |

Layers of protection: Caddy limits bodies to 32 KB (the relay allows 16 KB); the relay enforces content type, JSON, size, origin, honeypot, per-IP rate limit and full server-side validation; Company OS then verifies the signature, enforces its own limit (**20 requests/minute per source IP, and the relay's address is the one it sees**, so total Rokn traffic is capped at 20/min) and de-duplicates on the lead id. If abuse ever appears, add Cloudflare Turnstile to the form rather than loosening these.

## 3. One-time setup on the VM

### 3.1 Confirm the private network name
```bash
docker network ls --format '{{.Name}}' | grep companynet     # expect company-os_companynet
```
If the name differs, export it before every compose command: `export COMPANY_NET=<name>`.

### 3.2 Get the code onto the VM (repo root = `/opt/rokn-relay`)
```bash
# Option A (after the push is approved): clone the reviewed commit
sudo mkdir -p /opt/rokn-relay && sudo chown "$USER" /opt/rokn-relay
git clone https://github.com/mohsinalinasir13/rokn-al-ahlam-website.git /opt/rokn-relay
cd /opt/rokn-relay && git checkout <APPROVED_SHA> && git rev-parse HEAD

# Option B (no push): from the development PC, upload a tarball and check its hash on both ends
#   git archive <SHA> server src/enquirySchema.js deploy/relay .dockerignore -o rokn-relay.tar ; sha256sum rokn-relay.tar
#   then on the VM:  mkdir -p /opt/rokn-relay && tar -x -C /opt/rokn-relay -f rokn-relay.tar ; sha256sum rokn-relay.tar
```
`relay.env` lives at the repo root, is git-ignored, and is never part of either option, so a redeploy cannot overwrite or leak it.

### 3.3 Create `relay.env` without ever displaying the secret
```bash
cd /opt/rokn-relay && umask 077
cp deploy/relay/relay.env.example relay.env
S=$(grep -m1 '^WEBSITE_WEBHOOK_SECRET=' /opt/company-os/.env.production | cut -d= -f2-)
[ -n "$S" ] || { echo "WEBSITE_WEBHOOK_SECRET not found in Company OS config"; unset S; exit 1; }
sed -i "s|^COMPANY_OS_WEBHOOK_SECRET=.*|COMPANY_OS_WEBHOOK_SECRET=${S}|" relay.env
unset S; chmod 600 relay.env
# verify WITHOUT printing it: expect 1
grep -c '^COMPANY_OS_WEBHOOK_SECRET=.\{32,\}$' relay.env
ls -l relay.env      # expect -rw------- and your user
```

### 3.4 Pre-flight checks (change nothing in production)
```bash
cd /opt/rokn-relay
docker compose -f deploy/relay/docker-compose.relay.yml config > /dev/null && echo "compose OK"

# Validate the Caddy change on a COPY of the live file; the live file is not touched
(cat /opt/company-os/infra/caddy/Caddyfile; echo; cat deploy/relay/Caddyfile.lead) > /tmp/Caddyfile.new
docker run --rm -e COMPANY_OS_DOMAIN=os.bestwaysolutions.ae \
  -v /tmp/Caddyfile.new:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```
Stop here if either check fails.

### 3.5 Start the relay (independent container; Company OS is not restarted)
```bash
cd /opt/rokn-relay
docker tag rokn-relay:current rokn-relay:previous 2>/dev/null || true          # keep the last good image
docker compose -f deploy/relay/docker-compose.relay.yml up -d --build
for i in $(seq 1 20); do s=$(docker inspect -f '{{.State.Health.Status}}' rokn-relay); echo "$s"; [ "$s" = healthy ] && break; sleep 3; done
docker logs --tail 5 rokn-relay                                                  # expect relay_listening, configured:true
# relay -> Company OS over the private network:
docker exec rokn-relay node -e "fetch('http://app:8000/api/v1/health').then(r=>r.text()).then(console.log)"
ss -ltn | grep -c ':8787 ' || true                                               # expect 0: nothing published on the host
```

### 3.6 Publish `lead.roknalahlam.com` (after the A record resolves)
```bash
dig +short lead.roknalahlam.com                                                  # expect 84.235.246.14
cd /opt/company-os
cp -p infra/caddy/Caddyfile infra/caddy/Caddyfile.bak-$(date +%F)                # rollback copy
# Write IN PLACE (same file, same inode) so the running container sees it. git pull/sed -i/mv would
# replace the file and leave Caddy reading the old one through its single-file bind mount.
cat /tmp/Caddyfile.new | tee infra/caddy/Caddyfile > /dev/null
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T caddy grep -c 'lead.roknalahlam.com' /etc/caddy/Caddyfile   # expect 1
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile
docker compose --env-file .env.production -f docker-compose.prod.yml logs caddy --since 5m | grep -i -E 'obtain|certificate|error' | tail
echo | openssl s_client -connect lead.roknalahlam.com:443 -servername lead.roknalahlam.com 2>/dev/null | openssl x509 -noout -issuer -dates
curl -sSI https://lead.roknalahlam.com/ | head -3                                # 404 over valid TLS = catch-all working
```
Also land the same change in the Company OS repo (use `company-os-caddyfile.patch`) so the repository and the VM agree. Company OS's own site (`os.bestwaysolutions.ae`) is unaffected: `caddy reload` keeps the old configuration if the new one is invalid.

## 4. Health check and restart
```bash
cd /opt/rokn-relay
docker compose -f deploy/relay/docker-compose.relay.yml ps
docker inspect -f '{{.State.Health.Status}}' rokn-relay                          # healthy
# Public check that writes NOTHING (CORS preflight from the real origin):
curl -si -X OPTIONS https://lead.roknalahlam.com/api/enquiry -H 'Origin: https://roknalahlam.com' -H 'Access-Control-Request-Method: POST' | head -8   # 204 + access-control-allow-origin
docker compose -f deploy/relay/docker-compose.relay.yml restart rokn-relay       # in-flight requests may fail; the form shows a retry message
docker logs --since 1h rokn-relay
```
The relay's own `/api/health` is deliberately **not** public; only the container health check and `docker exec` use it.

## 5. Rollback (fastest first; Company OS data is never involved)
1. **Stop accepting enquiries:** `docker compose -f deploy/relay/docker-compose.relay.yml stop rokn-relay`. The form then shows "we couldn't send your enquiry" with the phone and email, so nothing is lost silently.
2. **Remove the public route:** `cat infra/caddy/Caddyfile.bak-<date> | tee infra/caddy/Caddyfile >/dev/null` in `/opt/company-os`, then the same `caddy reload`.
3. **Previous relay image:** `RELAY_TAG=previous docker compose -f deploy/relay/docker-compose.relay.yml up -d --no-build`.
4. **Previous code:** `git checkout <previous SHA>` and repeat 3.5.
The DNS record can stay; without the Caddy block it simply answers 404.

## 6. Production go-live gate

Run in this order, once DNS, the secret and the approvals are in place. Do **not** call the website release-ready until every step passes.

1. Deploy: sections 3.1–3.6.
2. Health: section 4 (container `healthy`, preflight returns 204).
3. **Exactly one controlled real enquiry.** Preferred: from the live website's Contact form once the site is deployed, with browser DevTools open, so one submission also proves the browser side. If the site is not yet deployed, use this request through the real public route:
```bash
cd /opt/rokn-relay
LEAD_ID=$(python3 -c 'import uuid;print(uuid.uuid4())'); MARK="GOLIVE-$(date +%Y%m%d%H%M)"
cat > /tmp/golive.json <<JSON
{"id":"$LEAD_ID","enquiryType":"owner-management","consent":true,"page":"/contact","referrer":"","utm":{"utm_source":"golive-test"},"submittedAt":"$(date -u +%FT%TZ)","hp":"","fields":{"name":"$MARK do not contact","phone":"+971500000000","email":"golive-test@roknalahlam.com","service":"Property Management","ptype":"Villa","emirate":"Dubai","area":"Go-live test","notes":"Controlled production test, please ignore"}}
JSON
curl -sS -m 20 -X POST https://lead.roknalahlam.com/api/enquiry -H 'content-type: application/json' -H 'Origin: https://roknalahlam.com' --data @/tmp/golive.json -o /tmp/golive.resp -w 'HTTP %{http_code}\n'
cat /tmp/golive.resp                                    # expect {"ok":true,"reference":"RA-XXXXXXXX"}
```
4. **Prove the central record exists** (the admin key is read server-side and never printed; only non-personal fields are shown):
```bash
ADMIN=$(grep -m1 '^ADMIN_API_KEY=' /opt/company-os/.env.production | cut -d= -f2-)
REF=$(python3 -c "import json;print(json.load(open('/tmp/golive.resp'))['reference'])")
curl -sS -m 20 -H "Authorization: Bearer $ADMIN" https://os.bestwaysolutions.ae/api/v1/revenue/prospects | LEAD_ID="$LEAD_ID" REF="$REF" python3 -c "
import sys,json,os
recs=[p for p in json.load(sys.stdin) if (p.get('research') or {}).get('source_lead_id')==os.environ['LEAD_ID']]
print('records for this lead id:',len(recs))
r=recs[0]; m=r['research']['lead_metadata']
print('record id:',r['id'],'| source:',r['source'],'| site:',m['site'],'| type:',m['enquiryType'])
# 5. the reference must be derived from that record's id
print('reference matches record:', r['id'].replace('-','').upper().startswith(os.environ['REF'][3:]))"
unset ADMIN
```
5. (in step 4) the returned `RA-…` reference must match the stored record id.
6. **No personal data in logs:**
```bash
docker logs --since 30m rokn-relay 2>&1 | grep -c -i -E 'golive|@|\+971|do not contact|Go-live test'      # expect 0
docker logs --since 30m rokn-relay 2>&1 | tail -5                                                          # only evt/type/ref/ms lines
```
   Browser: with DevTools open on the live Contact page during step 3, the Console must show no application output containing the entered data (the code emits none; only the browser's own network-status lines for failed requests can appear).
7. **Controlled failure** (throwaway container with a deliberately wrong secret; production relay untouched):
```bash
docker run -d --rm --name rokn-relay-failtest --network "${COMPANY_NET:-company-os_companynet}" --read-only --cap-drop ALL \
  --env-file relay.env -e COMPANY_OS_WEBHOOK_SECRET=wrong-on-purpose rokn-relay:current
sleep 3
docker exec rokn-relay-failtest node -e "fetch('http://127.0.0.1:8787/api/enquiry',{method:'POST',headers:{'content-type':'application/json',origin:'https://roknalahlam.com'},body:JSON.stringify({id:require('crypto').randomUUID(),enquiryType:'vacation-home',consent:true,hp:'',fields:{name:'GOLIVE failure test',phone:'+971500000000',email:'golive-fail@roknalahlam.com',location:'x'}})}).then(async r=>console.log(r.status,await r.text()))"
docker rm -f rokn-relay-failtest
# expect: 502 {"ok":false,"code":"upstream_rejected",...} and NO record for golive-fail@roknalahlam.com
```
8. **Retry does not duplicate:** re-send the same file and re-run the step 4 query.
```bash
curl -sS -m 20 -X POST https://lead.roknalahlam.com/api/enquiry -H 'content-type: application/json' -H 'Origin: https://roknalahlam.com' --data @/tmp/golive.json
# expect the SAME reference, and "records for this lead id: 1"
```
Leave the test record in place as an audit trail (Company OS has no delete); its name says "do not contact". Remove `/tmp/golive.*` afterwards.

## 7. Logging requirements (zero customer PII)

- The relay writes only JSON lines with `evt`, `type`, `code`, `upstreamStatus`, `ref` and `ms`: never names, emails, phones, notes, IPs or the secret. This is enforced by a unit test.
- **No proxy access log** is configured for `lead.roknalahlam.com` (Caddy logs none by default), so no IP addresses are written to disk. Do not add a `log` directive without filtering.
- Docker keeps stdout for 3 × 10 MB then rotates. Never log request bodies while debugging; add temporary logging only on a copy and delete it.

## 8. Network and firewall

- Publish nothing new: no `ports:` on `rokn-relay` (and never on `app` or `db`; Docker-published ports bypass `ufw`). Only Caddy is public.
- Oracle security list and `ufw` stay at **22/80/443 only**; verify with `sudo ufw status numbered` and `ss -ltn` (nothing on 8787 or 8000).
- Restrict SSH (22) to Mohsin's IP in the Oracle security list (already a standing recommendation in Company OS's infrastructure notes).
- The relay needs no outbound access except the private `app` service; it is on the shared `companynet` network with the database, so keep its filesystem read-only and capabilities dropped as configured.
- Consider reserving the public IP (a fixed address pins both DNS records).

## 9. Website side (separate approval)

`.env.production` sets `VITE_ENQUIRY_ENDPOINT=https://lead.roknalahlam.com/api/enquiry` (a public URL, not a secret). Deploy the relay **first**, then the website. If the site is deployed while the relay is down, the form fails closed: it shows "we couldn't send your enquiry" and never a false thank-you. The build contains no secret.

## 10. Next workflow gap (after production intake is proven)

A separate task: **new lead → internal staff alert + customer acknowledgement.** Company OS currently stores the lead and writes an audit event but notifies no one, and its outbound email is disabled. Delivery channels are to be decided separately; until then, someone must watch the Operations Room.
