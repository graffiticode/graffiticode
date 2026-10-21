# Egress proxy (ISOLATE-01)

The enforced outbound control for compilers: Envoy on two Container-Optimized OS VMs, behind an
internal passthrough Network Load Balancer, in the `compilers` VPC. The design and its reasons
are in the ISOLATE-01 plan (`~/.claude/plans/isolate-01-compiler-egress.md`, "The proxy").
A sequence diagram of the flows (identity, Policy, Broker, refusals, the open class) is
[docs/isolate-01-compiler-egress.html](../../docs/isolate-01-compiler-egress.html), and the
architecture before it (production until 2026-10-19), with each vulnerability it closed, is
[docs/isolate-01-compiler-egress-today.html](../../docs/isolate-01-compiler-egress-today.html); open
them in a browser.

**Status: deployed; ISOLATE-01 closed 2026-10-20 with recorded residuals.** Every compiler is
behind the proxy: the 36 in `deploy.json` (their `network` blocks) and the 26 legacy ones
deployed from their own repos (`production/network.json`, `"legacy": true`; D6 ended
2026-10-20). Live: the group `egress-proxy` on template `egress-proxy-0cfb77e009f1`, config
`1aa650b0` (2026-10-20). `infra.js --apply` refuses production, so production changes are
`--plan`'s output, run by hand. The records are in the as-built record and the IAM review, §4
item 7.

| File | What it is |
| --- | --- |
| `classes.json` | The compiler classes (a subnet each), the open class's refused names, and the proxy's fixed settings, with `envoyImage`, `reportImage` and `cosImage` pinned (step 0, then each patch) |
| `production/network.json` | Every compiler's `network` block: the 36 also in `deploy.json` (a test holds them identical) and the 26 legacy compilers (`"legacy": true`), which `scripts/legacy-network-check.js` checks live |
| `generate.js` | `deploy.json` + `classes.json` → `out/envoy.json`, `out/cloud-init.yaml` and `out/alerts/*.json`, and prints the config digest |
| `digest.js` | The config digest's canonical form and normalisation, shared by the generator and the VM's config report |
| `infra.js --plan` | The gcloud commands for the VPC, firewall policy and rules, DNS, NAT, identity, secrets, template, group, load balancer, alerts and rolling update |
| `refusals.js` | The inventory's query: what a class was refused since a time, and the refused destinations from the saved log lines |
| `verify-rollout.js` | After a rolling update: is every VM running the expected config digest? |
| `issue-certs.sh` | The private CA (once, offline) and one certificate per terminated host |
| `test/` | Golden files, structural and behavioural tests, a model of Envoy's routing (`route-sim.js`) (`npm run test:egress-proxy`) |

## How a request is handled

1. A compiler sends `CONNECT host:443` to `http://<LB IP>:3128`. The class is the filter
   chain matching the connection's **direct source address**. There's no PROXY protocol, and
   `X-Forwarded-For` isn't trusted. A source outside every class subnet has no chain, so it's
   closed (logged as `egress-tcp`, flags `NR`).
2. A trailing dot is stripped before routing (`strip_trailing_host_dot`), and an authority
   still ending in a dot gets 403 `trailing-dot`.
3. **Listed host:** the CONNECT is terminated and its bytes go to that host's own internal
   cluster, `terminate-<class>-<host>`. Its single endpoint is the class's internal listener,
   `terminate-<class>`, and carries the target as endpoint metadata (`isolate01.target`),
   passed into the internal connection with `passthrough_metadata` of kind `host`. There:
   - the SNI picks the host's filter chain (an unknown SNI is closed, logged `terminate-tcp`);
   - RBAC requires `isolate01.target` to equal that SNI (a refusal is logged `terminate-tcp`,
     termination details naming rbac);
   - the HTTP route accepts only that host as `Host` / `:authority`, and anything else gets a
     403 `host-mismatch`.

   Envoy then opens its own TLS to the host, verifying the public certificate for that name.
   The host's cluster follows its DNS record's TTL (`envoy.clusters.dns`, `respect_dns_ttl`),
   and its route retries once (`retryPolicy` in `generate.js`): on `connect-failure,reset` for
   hosts that take reads (`*.graffiticode.org`, `www.googleapis.com`), and only on
   `connect-failure,reset-before-request` for Policy, Broker and Cloud Storage, so a write is
   never sent twice.
4. **Unlisted host:**
   - Strict classes: 403 `unlisted`.
   - The open class (L0185 and `l0185r`, and the legacy l0137 and l0170; D2): names under
     `open.denySuffixes` get 403 `name`, IP literals 403 `ip-literal`, and CONNECTs to any port but 443 (matched by suffix: Envoy's regexes are
     full-match) get 403 `port`. Everything else goes through the dynamic forward proxy (IPv4
     only, through the fixed resolvers), and so does plain `http` in absolute form. The open
     class can never *list* a refused name: an exact listed route would win over the
     wildcard refusal, so the generator rejects it.
5. Whatever a name resolved to, **the network decides where a new connection may go**:
   - the `ENVOY_OUT` iptables chain, for Envoy's UID 10101;
   - the VPC firewall, for the proxy's service account.

   Private, loopback, link-local (metadata), CGNAT, multicast, reserved, Google private-access,
   compiler and load-balancer addresses are refused. Each `ENVOY_OUT` REJECT is logged just
   before it (rate-limited) as `ISOLATE01-REJECT <name> ... DST=<address> DPT=<port>` in the
   kernel log, and the proxy's deny-internal VPC rule is logged too: AT-11's evidence that a
   control, not a dead destination, refused a connection. The names (`rejectRules` in
   `generate.js`, at most 11 characters: a LOG prefix is at most 29):

   | Name | Range |
   | --- | --- |
   | `lb` | the load balancer |
   | `c-<class>` | a compiler subnet (`compilers-` dropped) |
   | `proxy-net` | the proxy subnet |
   | `metadata` | `169.254.0.0/16` |
   | `private` | `10/8`, `172.16/12`, `192.168/16` |
   | `cgnat`, `zero`, `loopback`, `multicast`, `reserved` | `100.64/10`, `0/8`, `127/8`, `224/4`, `240/4` |
   | `goog-priv`, `goog-restr` | `199.36.153.8/30`, `199.36.153.4/30` |

**Logs** (JSON on stdout, shipped by COS's logging agent). Every HTTP line, outer (`egress`) and
inner (`terminate`), has `class`, `downstream`, `method`, `target`, `sni`, `host`, `upstream`
(the resolved address), `upstream_host`, `code`, `flags`, `details`, `decision` (`allow` or
`refuse`), `reason` (the refusal, or `listed` / `open`), `probe` (AT-11's `x-isolate01-probe`
header) and `start`. Every route sets `x-isolate01-decision` and `x-isolate01-reason`, every 403
also `x-isolate01-refused: <reason>`, and allowed routes remove any upstream
`x-isolate01-refused`, so an upstream can't forge a refusal. Connection-level lines
(`egress-tcp`, `terminate-tcp`) record what closes before HTTP runs: `sni`, the passed-through
`target`, `flags`, `termination` and `filter_chain`. `refusals.js` reads them all. Inner lines
also log `path`, without its query (`%PATH(NQ:PATH)%`, since 2026-10-20): a query can carry a
token, such as L0013's `/form?access_token=…`.

## The VM

- **Units:**
  - `egress-resolver.service` runs first: host DNS (docker's image pull, the certificate
    fetch, the logging agent) goes to the fixed resolvers only, through a static
    `/etc/resolv.conf` and systemd-resolved with no fallback, and `metadata.google.internal`
    is pinned in `/etc/hosts`. The compilers' DNS response policy binds to the whole VPC, so
    the metadata resolver would answer NXDOMAIN here too; queries sent straight to the fixed
    resolvers bypass it. `resolver-check.sh` gates the certificate fetch and Envoy.
  - `egress-firewall.service` installs `ENVOY_OUT`, `EGRESS_IN` (ending in its own DROP) and
    the `ip6tables` drop.
  - `egress-certs.service` (root) fetches each `egress-proxy-cert-<host>` into tmpfs
    `/run/egress-proxy/certs`, owned by 10101.
  - `egress-envoy.service` runs `resolver-check.sh` and `firewall-check.sh` first, and won't
    start Envoy unless the chain holds every generated rule, nothing else, in order (return
    traffic, then logged rejects, then accepts, then drop), each REJECT just after its LOG,
    with Envoy's UID sent to it first in `OUTPUT`, and `EGRESS_IN` whole.
  - `envoy-config-report.timer` runs `envoy-config-report.service` 3 minutes after boot and
    every 10 minutes: see "Config digest".
- Envoy runs `--network host --user 10101:10101 --cap-drop ALL --read-only`. Host networking
  is what makes the UID rules apply. **Never run a bridged container on these VMs**: its
  traffic would take Docker's forwarding chains and miss `ENVOY_OUT`. The config report also
  runs on the host network, as UID 10102.
- `ENVOY_OUT` accepts `ESTABLISHED,RELATED` first, which carries the replies to compilers and
  health checks. Only then does it filter `NEW` connections.
- `INPUT` takes TCP 3128 from the compiler subnets and 3129 (the health check) from the
  health-check ranges, loopback and return traffic, and drops the rest itself.
- The admin interface is on `127.0.0.1:9901` only. Check it from the VM:
  `curl -s localhost:9901/stats | grep isolate01`.
- The service account `egress-proxy` has only these roles:
  - `secretAccessor` on the `egress-proxy-cert-*` secrets;
  - `roles/logging.logWriter` and `roles/monitoring.metricWriter`, for the logging agent.

  Envoy's UID can't reach metadata, so it can't use any of them.

## The compiler firewall

Compilers are held by a **global network firewall policy**, `compilers-egress`, whose egress rules
match the compiler subnets **by source range** (classic VPC egress rules can only target tags or
service accounts, and a tag is something a deployment could leave out): allow TCP 3128 to the
load balancer; deny DNS and DoT anywhere; deny everything else. Both denies are logged. The
metadata server is reached directly and can't be blocked; the DNS response policy is its control.

## Config digest

Envoy has no config digest of its own, so `generate.js` writes two into the bootstrap's
`node.metadata.isolate01`: `resources_sha256`, over the static listeners and clusters
normalised as Envoy's config dump renders them (`digest.js`), and `config_sha256`, over the
whole bootstrap with itself left out. The instance template carries `config_sha256` as
`isolate01-config-sha256`. `generate.js` prints it.

On each VM, `envoy-config-report.service` runs `config-report.mjs` in the pinned Node image. It
reads the running Envoy's `/config_dump?mask=bootstrap.node.metadata` (not `resource=`, which
takes only repeated fields), takes the digest from the `BootstrapConfigDump` entry, recomputes
`resources_sha256` from the full `/config_dump` with `digest.js`'s own code, and logs
`{isolate01: "config", instance, config_sha256, resources_sha256, match}`. `match` is true
only if the running digest is the template's and the resources hash to what the generator
wrote. An alert fires on any `match: false`.

## Operations

**Change a compiler's hosts** (the inventory loop, rollout step 3, and any later change). The
Envoy config is static, so re-releasing a compiler with a new `network.allow` changes nothing on
the proxy: the proxy is updated, and verified, **before** the compiler's candidate is retried.
1. Edit its `network.allow` in `deploy.json` (reviewed with the service). For L0185, never a
   name its class refuses: `generate.js` rejects it.
2. Run `node deploy/egress-proxy/generate.js` and review the `out/` diff (the tests must be
   green). Note the printed `config_sha256`.
3. For each new host (every listed host is terminated, so each needs one): issue its
   certificate and add its `egress-proxy-cert-<host>` secret, readable by `egress-proxy` only
   (see "Certificates").
4. Build a new instance template from `out/cloud-init.yaml`, carrying the new
   `isolate01-config-sha256` (`infra.js --plan` prints the command), and run a rolling update.
   Keep the old template.
5. Verify:
   - `envoy --mode validate -c out/envoy.json` on the pinned Envoy image;
   - `node deploy/egress-proxy/verify-rollout.js --expect <config_sha256>`: run the commands it
     prints, then judge with `--instances` and `--logs`. It fails if any VM still reports the
     previous digest, has no report since it was created, or reports `match: false`;
   - a probe job for the class reaches the new host through the load balancer, and an unlisted
     host is still refused.
6. Only then re-stage the compiler's candidate.
7. Record the list in `docs/capability-policy-iam-review.md`.

**Inventory.** `node deploy/egress-proxy/refusals.js --class <class> --since <time>` prints the
log query for what a class was refused; run it, then `--parse` the saved file for each refused
destination with its reason and count. Review each: list it (the loop above) or record it as not
needed.

**Rolling update** (config, Envoy digest or COS image):
1. Create `egress-proxy-<version>` from the new `out/cloud-init.yaml`.
2. Run
   `gcloud compute instance-groups managed rolling-action start-update egress-proxy --version=template=egress-proxy-<version> --max-surge=2 --max-unavailable=0`.
   A regional group's fixed surge must be 0 or at least its number of zones, and the group
   pins two (`classes.json` `proxy.zones`).
3. Watch the health check and the refusal metric, then run `verify-rollout.js`.

   **Every rollout fires the unhealthy alert** (the `egress-proxy-unhealthy` metric), and
   that's expected. Each old VM is reported UNHEALTHY as it shuts down. Check the order in the
   health-check log (`logName:"compute.googleapis.com%2Fhealthchecks"`) against the group's
   `compute.instances.delete` calls: each new VM must be HEALTHY before the group deletes an
   old one, and each UNHEALTHY must be an old VM's address after its delete call.
   - The 2026-10-20 rollout (`egress-proxy-39f91cc71d09`) went that way: new VM HEALTHY
     15:58:26, then old delete 15:58:30, old UNHEALTHY 15:58:46; then new HEALTHY 15:59:56,
     old delete 16:00:07, old UNHEALTHY 16:00:22.
   - An UNHEALTHY on a new VM, or one with no delete before it, is a real failure. Roll back.

**Rollback:** the same command with the previous template, which is always kept.

**Cloud NAT has 4096 ports per VM and a 10 s UDP timeout** (`infra.js`). Envoy used to
re-resolve every terminated host's cluster every 5 s, from a fresh source port. At the defaults
(64 ports, 30 s), 48 hosts exhausted the NAT, and it dropped DNS queries (2026-10-20). The
terminated hosts kept their last address, but the open class's fresh lookups failed. Since config
`1aa650b0` each terminated host's cluster is a DNS cluster (`envoy.clusters.dns`) that follows
the record's TTL (`respect_dns_ttl`; 300 s for the Cloudflare names), so the load is far lower. After a rollout that adds
hosts, check for drops:
`gcloud logging read 'resource.type="nat_gateway" AND jsonPayload.allocation_status="DROPPED"' --freshness=30m`.

**Patching.** COS auto-update is disabled (`cos-update-strategy=update_disabled`), and in-place
updates don't reboot anyway, so the fleet is only ever replaced:
1. Monthly, and on any COS or Envoy advisory, pick the newest image on the chosen COS LTS
   milestone (`gcloud compute images list --project cos-cloud --filter="family~cos-<milestone>-lts"`)
   and the new Envoy and Node (report) digests.
2. Set them in `classes.json`, then regenerate, build a template and run a rolling update.
3. Record the date and versions here:

| Date | COS image | Envoy digest | Node digest | By |
| --- | --- | --- | --- | --- |
| 2026-10-18 | `cos-129-19506-549-7` | `envoyproxy/envoy@sha256:74bd4eb5…cc01` | `node@sha256:0a7108bf…e402` | Jeff (step 1) |

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
  - **Production expiry:**
    - the first five host certificates (2026-10-18): 2027-11-19;
    - `storage.googleapis.com`, `app.graffiticode.org` and the language hosts (2026-10-20):
      2027-11-21;
    - the CA: 2036-10-15.

    Rotate the hosts by 2027-10-20.
- **Rotating the CA:**
  1. Publish a bundle with both the old and the new CA.
  2. Roll the compilers onto it.
  3. Switch the host certificates.
  4. Then drop the old CA from the bundle.

## Rollout step 1: production infrastructure

Step 1 ran on 2026-10-18, after step 0 passed (see the next section). It built the same stack
in `graffiticode`, and this section records how. Jeff runs the commands. `infra.js --apply` refuses production, so step 1 is
`--plan`'s output, run by hand.

**Inputs:**
- `classes.json` holds the production classes:
  - `compilers-default`;
  - `compilers-l0185` (open, D2);
  - one class per language with reviewed external hosts: `compilers-l0000` and
    `compilers-l0176` (`www.googleapis.com`), and `compilers-l0013`
    (`storage.googleapis.com`).

  Its images are step 0's pins.
- `production/network.json` held the planned `network` blocks of the first wave, L0176 and
  L0000, which stayed out of `deploy.json` until rollout step 3 (a `deploy.json` block puts
  that service on the proxy at its next release, routine ones included). It now holds every
  compiler's block. A test (`production.test.js`) refuses any `deploy.json` block that
  `production/network.json` doesn't hold, identically.

**Before running anything:**
1. Create a **fresh** production CA on an offline machine:
   `issue-certs.sh ca <offline-dir>`. Don't reuse `~/isolate01-ca`, which belongs to the
   scratch prototype.
2. Issue one certificate per terminated host, into the working directory:
   `issue-certs.sh issue <offline-dir> <workdir>/certs <host>...`. The hosts are the ones
   `generate.js` lists. For the first wave they are `api.graffiticode.org`,
   `auth.graffiticode.org`, `broker-sja7fatcta-uc.a.run.app`,
   `policy-sja7fatcta-uc.a.run.app` and `www.googleapis.com`.
3. Copy the CA's public `ca.crt` into `<workdir>`.
4. Generate into `<workdir>/out`:
   `node deploy/egress-proxy/generate.js --deploy deploy/egress-proxy/production/network.json --out <workdir>/out`.
   Don't pipe it into `head`: a closed pipe killed it before it wrote cloud-init in step 0.
5. Validate on the pinned Envoy, as in step 0 (`validate/cloudbuild.yaml`). That needs no
   production access.
6. Pick a notification channel and set `proxy.alerts.notificationChannels` in
   `classes.json`, or the alert policies alert no one.

**Then** print the commands with
`node deploy/egress-proxy/infra.js --plan --deploy deploy/egress-proxy/production/network.json`,
and run them from `<workdir>`, step by step, in their order. Two steps aren't idempotent:
`secrets versions add` and `monitoring policies create`. Run each of those once. Step 1
changes no compiler: none uses the proxy until its step 3 candidate.

**Expect one transient heartbeat alert.** The heartbeat metric counts only from its creation in
step 10, so its first 5-minute window is partial. The fleet heartbeat alert can open on it and
close by itself within about 15 minutes. In step 1 it was open from 23:15 to 23:19 UTC, with a
first window of 22 lines; every window after was about 700. Later rollouts don't cause it:
the alert watches the fleet's total, and a surge only adds lines.

**Done when:**
- `verify-rollout.js --expect <config_sha256>` passes on both VMs;
- the heartbeat, refusal, unhealthy and config-mismatch policies exist;
- the CA bundle is readable by `l0000-run` and `l0176-run`, and each
  `egress-proxy-cert-*` by `egress-proxy` alone.

## Before production (rollout step 0)

**The prototype is retired.** Its projects, `graffiticode-isolate01` and
`graffiticode-isolate01-ctl`, were deleted on 2026-10-21 (recoverable until about 2026-11-20).
- The `at11.graffiticode.org` delegation was removed at Cloudflare first, so it can't dangle.
- Config validation now runs in `graffiticode` (below).
- A later AT-11 run needs new control resources, a DNS-exfiltration zone and rebinding names in
  place of step 0's. `scripts/at11/step7-jobs.js` and `step7/at11/` still name the old ones.

This section records how step 0 ran.

**Running step 0.** The prototype lived in the scratch project `graffiticode-isolate01`, created
2026-10-17. Its config is `step0/`:
- `step0/classes.json`: the production classes plus `compilers-ext`, a class with a reviewed
  external host, so all three kinds are proved;
- `step0/deploy.json`: three probe services (`probe-default`, `probe-ext`, `probe-l0185`), each
  with its own runtime account.

`infra.js --apply` runs the same commands `--plan` prints, one step at a time, and only there:

```
node deploy/egress-proxy/infra.js --plan  --classes deploy/egress-proxy/step0/classes.json --deploy deploy/egress-proxy/step0/deploy.json
node deploy/egress-proxy/infra.js --apply --steps 1,2,3 --classes deploy/egress-proxy/step0/classes.json --deploy deploy/egress-proxy/step0/deploy.json
```

It refuses:
- any project outside `SCRATCH_PROJECTS`, production included;
- any command that names another project;
- a placeholder still in a command, such as an unpinned image;
- a step with an open, commented-out choice (the DNS lockdown's form), until it's settled in
  `infra.js`.

It runs each argv without a shell. A resource that already exists is recorded and skipped,
and any other failure stops the run. Instance templates are named by their config's digest, so
a new config always means a new template.

**Validating a config.** `validate/cloudbuild.yaml` runs `envoy --mode validate` on the pinned
Envoy in Cloud Build, with throwaway certificates at every path the config names (see its
header). Since 2026-10-21 it runs in `graffiticode` as `deploy-build`. `validate/path-format/`
runs the pinned Envoy on a real request, for a log-format change. It fails on an invalid config, and on any Envoy deprecation warning. Step 0's config
passed on `envoyproxy/envoy:v1.39.4` on 2026-10-18 (9 clusters, 5 listeners). That includes
host-kind `passthrough_metadata`, and the inner RBAC filter's `sourced_metadata` principal,
which replaced the deprecated `Principal.metadata`.

The DNS-exfiltration check's authoritative server was the public Cloud DNS zone
`at11.graffiticode.org`. It was in the scratch project, with query logging, delegated from
Cloudflare by four NS records (removed 2026-10-21). Resolvers randomise the case of names they pass on, so the log
is matched without case.

The prototype showed each check in the plan's step 0. It's also where these were settled, each
an assumption the offline tests can't prove:
- `envoy --mode validate -c out/envoy.json` on the pinned digest;
- that host-kind `passthrough_metadata` reaches the inner listener's connection dynamic
  metadata, where the RBAC `metadata` principal reads it (a listed tunnel succeeds, and one
  without the metadata is refused), and whether `%DYNAMIC_METADATA(isolate01:target)%` shows it
  in the inner HTTP log (`target_metadata`) as well as the connection-level one;
- that `strip_trailing_host_dot` applies to a CONNECT authority with a port (the `trailing-dot`
  refusal holds either way);
- that route `response_headers_to_add` reach the logged CONNECT 200 and local replies, so
  `decision` and `reason` are never `-` (`refusals.js` falls back to the 403 and its refusal
  header);
- that listener-level access logs fire for RBAC and no-filter-chain closes, with
  `%CONNECTION_TERMINATION_DETAILS%` naming rbac;
- that the config report's recomputed `resources_sha256` matches the generator's on the
  pinned Envoy (proto JSON's rendering of the dump);
- that Cloud Run's Direct VPC egress traffic matches the firewall policy's source ranges;
- that the proxy VMs' host DNS works with the lockdown active (a cold boot pulls, fetches,
  starts and ships logs), and that kernel `ISOLATE01-REJECT` lines reach Cloud Logging;
- the DNS lockdown's form (settled: the private root zone `compilers-root`, holding only
  `metadata.google.internal`).
