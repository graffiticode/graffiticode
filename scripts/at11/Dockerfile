# The AT-11 probe image (ISOLATE-01): net.js runs as each compiler account on its subnet with
# its network config; iam.js runs as each compiler account (and as at11-control) without it.
# Pure Node, no dependencies. Evidence goes to the job's log as one AT11-EVIDENCE line.
#
#   docker build -f scripts/at11/Dockerfile -t <registry>/at11-probe .
#   gcloud run jobs create at11-<lang> --image <registry>/at11-probe@<digest> \
#     --service-account <lang>-run@... [--network ... --subnet ... --vpc-egress all-traffic] \
#     --args scripts/at11/net.js,--class,<class>,--config,/config/at11.json,--out,/tmp
FROM node:22.23.3@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
WORKDIR /probe
COPY scripts/at11/lib.js scripts/at11/net.js scripts/at11/iam.js scripts/at11/
USER node
ENTRYPOINT ["node"]
