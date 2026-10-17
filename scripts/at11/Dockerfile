# The AT-11 probe image (ISOLATE-01). One image, one digest, for identity-bound jobs:
#   at11-net-<compiler>  net.js, as the compiler's account, on its subnet with its network config
#   at11-iam-<compiler>  iam.js --role compiler, as the compiler's account, without it
#   at11-iam-control     iam.js --role control, as at11-control
# Pure Node, no dependencies. Each job writes its evidence to its log as one AT11-EVIDENCE line,
# tagged with the run nonce (AT11_NONCE) and its execution (CLOUD_RUN_EXECUTION). The operator's
# collector (scripts/at11/collect.js, not in this image) starts the jobs with that nonce, reads the
# lines and the logs the jobs can't, and alone gives the verdict.
#
#   docker build -f scripts/at11/Dockerfile -t <registry>/at11-probe .
#   gcloud run jobs create at11-net-<lang> --image <registry>/at11-probe@<digest> \
#     --service-account <lang>-run@... --network ... --subnet ... --vpc-egress all-traffic \
#     --args scripts/at11/net.js,--class,<class>,--subject,<lang>-run,--config,/config/at11.json,--out,/tmp
#   gcloud run jobs create at11-iam-<lang> --image <registry>/at11-probe@<digest> \
#     --service-account <lang>-run@... \
#     --args scripts/at11/iam.js,--role,compiler,--subject,<lang>-run,--config,/config/iam.json,--out,/tmp
FROM node:22.23.3@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
WORKDIR /probe
COPY scripts/at11/lib.js scripts/at11/net.js scripts/at11/iam.js scripts/at11/
USER node
ENTRYPOINT ["node"]
