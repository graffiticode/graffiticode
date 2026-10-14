# Egress proxy (ISOLATE-01)

The enforced outbound control for compilers: Envoy on two Container-Optimized OS VMs, behind an
internal passthrough Network Load Balancer, in the `compilers` VPC. The design and its reasons
are in the ISOLATE-01 plan (`~/.claude/plans/isolate-01-compiler-egress.md`, "The proxy").

**Status: not deployed.** Deployment is deferred (2026-10-14). `infra.js` prints its commands
and refuses to run them, and no `deploy.json` service has a `network` block yet. Rollout step 0
(the prototype in a scratch project) comes before anything here touches production.

| File | What it is |
| --- | --- |
| `classes.json` | The compiler classes (a subnet each), the L0185 open class's refused names, and the proxy's fixed settings. `envoyImage` and `cosImage` are `null` until step 0 pins them |
| `generate.js` | `deploy.json` + `classes.json` → `out/envoy.json` and `out/cloud-init.yaml` |
| `infra.js --plan` | The gcloud commands for the VPC, firewall, DNS, NAT, identity, secrets, template, group, load balancer, alerts and rolling update |
| `issue-certs.sh` | The private CA (once, offline) and one certificate per terminated host |
| `test/` | Golden files and structural tests (`npm run test:egress-proxy`) |

## How a request is handled

1. A compiler sends `CONNECT host:443` to `http://<LB IP>:3128`. The class is the filter
   chain matching the connection's **direct source address**. There's no PROXY protocol, and
   `X-Forwarded-For` isn't trusted. A source outside every class subnet has no chain, so it's
   closed.
2. **Listed host:** the CONNECT is terminated and its bytes go to that class's own internal
   listener, `terminate-<class>`, carrying the target as route metadata (`isolate01.target`).
   There:
   - the SNI picks the host's filter chain (an unknown SNI is closed);
   - RBAC requires `isolate01.target` to equal that SNI;
   - the HTTP route accepts only that host as `Host` / `:authority`, and anything else gets a
     403 `host-mismatch`.

   Envoy then opens its own TLS to the host, verifying the public certificate for that name.
3. **Unlisted host:**
   - Strict classes: 403 `unlisted`.
   - L0185's open class: names under `open.denySuffixes` get 403 `name`, IP literals 403
     `ip-literal`, and CONNECTs to any port but 443 get 403 `port`. Everything else goes
     through the dynamic forward proxy (IPv4 only, through the fixed resolvers), and so does
     plain `http` in absolute form.
4. Whatever a name resolved to, **the network decides where a new connection may go**:
   - the `ENVOY_OUT` iptables chain, for Envoy's UID 10101;
   - the VPC firewall, for the proxy's service account.

   Private, loopback, link-local (metadata), CGNAT, multicast, reserved, Google private-access,
   compiler and load-balancer addresses are refused.

Every 403 carries `x-isolate01-refused: <reason>`, and every request logs one JSON line (stdout,
shipped by COS's logging agent). The line has `isolate01` (`egress` or `terminate`), `class`,
`downstream`, `target`, `sni`, `host`, `upstream` (the resolved address), `code`, `flags`,
`details` and `refused`.

## The VM

- **Units:**
  - `egress-firewall.service` installs `ENVOY_OUT`, `EGRESS_IN` and the `ip6tables` drop.
  - `egress-certs.service` (root) fetches each `egress-proxy-cert-<host>` into tmpfs
    `/run/egress-proxy/certs`, owned by 10101.
  - `egress-envoy.service` runs `firewall-check.sh` first, and won't start Envoy unless the
    chain holds every generated rule, nothing else, in order (return traffic, then rejects,
    then accepts, then drop), with Envoy's UID sent to it first in `OUTPUT`.
- Envoy runs `--network host --user 10101:10101 --cap-drop ALL --read-only`. Host networking
  is what makes the UID rules apply. **Never run a bridged container on these VMs**: its
  traffic would take Docker's forwarding chains and miss `ENVOY_OUT`.
- `ENVOY_OUT` accepts `ESTABLISHED,RELATED` first, which carries the replies to compilers and
  health checks. Only then does it filter `NEW` connections.
- The admin interface is on `127.0.0.1:9901` only. Check it from the VM:
  `curl -s localhost:9901/stats | grep isolate01`.
- The service account `egress-proxy` has only these roles:
  - `secretAccessor` on the `egress-proxy-cert-*` secrets;
  - `roles/logging.logWriter` and `roles/monitoring.metricWriter`, for the logging agent.

  Envoy's UID can't reach metadata, so it can't use any of them.

## Operations

**Change a compiler's hosts:**
1. Edit its `network.allow` in `deploy.json` (reviewed with the service).
2. Run `node deploy/egress-proxy/generate.js` and review the `out/` diff.
3. If there's a new host, issue its certificate and add the secret (below).
4. Build a new instance template and run a rolling update.
5. Record the list in `docs/capability-policy-iam-review.md`.

**Rolling update** (config, Envoy digest or COS image):
1. Create `egress-proxy-<version>` from the new `out/cloud-init.yaml`.
2. Run
   `gcloud compute instance-groups managed rolling-action start-update egress-proxy --version=template=egress-proxy-<version> --max-surge=1 --max-unavailable=0`.
3. Watch the health check and the refusal metric.

**Rollback:** the same command with the previous template, which is always kept.

**Patching.** COS auto-update is disabled (`cos-update-strategy=update_disabled`), and in-place
updates don't reboot anyway, so the fleet is only ever replaced:
1. Monthly, and on any COS or Envoy advisory, pick the newest image on the chosen COS LTS
   milestone (`gcloud compute images list --project cos-cloud --filter="family~cos-<milestone>-lts"`)
   and the new Envoy digest.
2. Set both in `classes.json`, then regenerate, build a template and run a rolling update.
3. Record the date and versions here:

| Date | COS image | Envoy digest | By |
| --- | --- | --- | --- |
| — | — | — | (not deployed) |

## Certificates

The CA is created once on an offline machine with `issue-certs.sh ca <dir>`. Its key never
leaves that machine.

- **Name constraints:** the CA can only sign `.run.app`, `.googleapis.com` and
  `.graffiticode.org`, which limits what a leaked key could impersonate. The last is there
  because compilers call `auth.graffiticode.org` (`AUTH_URL`) and `api.graffiticode.org`
  (`GRAFFITICODE_API_URL`). A reviewed external host outside those suffixes needs
  a new CA, with the constraint extended, distributed to every compiler.
- **Issuing:** run `issue-certs.sh issue <ca-dir> certs/ <host>...` with the hosts
  `generate.js` lists. Each certificate lasts 397 days. Then:
  `gcloud secrets versions add egress-proxy-cert-<host-with-dashes> --data-file=certs/<host-with-dashes>.pem`.
- **The CA bundle:** `ca.crt` alone is the payload of `egress-proxy-ca-bundle`. That's the
  only secret compiler accounts can read. Cloud Run mounts it at `network.ca.path`
  (`NODE_EXTRA_CA_CERTS`; Rust reads the same file).
- **Rotation:** 30 days before expiry, issue new certificates, add them as new secret
  versions, and run a rolling update. Each VM fetches `latest` at boot.
- **Rotating the CA:**
  1. Publish a bundle with both the old and the new CA.
  2. Roll the compilers onto it.
  3. Switch the host certificates.
  4. Then drop the old CA from the bundle.

## Before production (rollout step 0)

The prototype in a scratch project must show each check in the plan's step 0. It's also where
these get settled:
- `envoy --mode validate -c out/envoy.json` on the pinned digest;
- the DNS lockdown's form (`infra.js` marks it OPEN);
- that route metadata passes through `internal_upstream` to the inner RBAC filter.
