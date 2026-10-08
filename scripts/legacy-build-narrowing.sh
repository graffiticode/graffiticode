#!/usr/bin/env bash
# Narrow the legacy Cloud Build account (docs/capability-policy-iam-review.md,
# Step 11, "Deployment paths"): from project-wide run.admin and
# iam.serviceAccountUser to run.admin on the 25 services it alone still
# deploys and iam.serviceAccountUser on their runtime accounts. Run one phase
# at a time, in order, and read each phase's output before the next:
#
#   save       read-only: record the bindings needed to roll back
#   grant      add the 25 service grants and 25 account grants
#   verify     read-only: every scoped grant is in place
#   remove     remove the two project-wide grants
#   check      read-only (wait for propagation first): the Troubleshooter's
#              allow-policy answer must be NOT_GRANTED for updating the five W4
#              services and acting as their identities, and GRANTED for the 25.
#              It judges allow policies only: deny policies can't be read with
#              the operator's access (the overall answer is UNKNOWN_INFO). An
#              unseen deny can only remove access, so the W4 negatives stand;
#              `test` proves the 25 still work.
#   test       redeploy l0158's current image through a build that runs as the
#              legacy account (a new revision with the same code), proving the
#              scoped grants work with the broad ones gone
#   rollback   re-add the two project-wide grants. Only if a legitimate deploy
#              breaks; the gate stays open until the narrowing is redone.
#
# The order matters: IAM permissions are additive, so a deploy test passes
# while the project-wide grants remain, whatever the scoped grants are. Only
# `test` after `remove` shows the scoped grants are enough.
set -euo pipefail

P=graffiticode
REGION=us-central1
LEGACY=656973052505@cloudbuild.gserviceaccount.com
MEMBER="serviceAccount:$LEGACY"
SERVICES="l0002 l0011 l0012 l0137 l0151 l0152 l0153 l0154 l0155 l0156 l0157 l0158 l0159 l0160 l0161 l0163 l0165 l0166 l0167 l0168 l0169 l0170 l0171 l0172 l0173"
W4="policy broker api l0000 l0176"
OUT=".gc-deploy/iam/legacy-build-narrowing"
sa() { echo "$1-run@$P.iam.gserviceaccount.com"; }
w4sa() { case "$1" in policy|broker|api|l0000|l0176) echo "$1-run@$P.iam.gserviceaccount.com" ;; esac; }
mkdir -p "$OUT"

# Does this IAM policy (JSON on stdin) bind $MEMBER to exactly this role,
# unconditionally? Exit 0 if so.
has_binding() { # role
  python3 -c '
import json, sys
role, member = sys.argv[1], sys.argv[2]
policy = json.load(sys.stdin)
ok = any(b.get("role") == role and member in b.get("members", []) and not b.get("condition") for b in policy.get("bindings", []))
sys.exit(0 if ok else 1)' "$1" "$MEMBER"
}

troubleshoot() { # resource permission -> the allow-policy access state
  gcloud policy-intelligence troubleshoot-policy iam "$1" --principal-email="$LEGACY" --permission="$2" \
    --project=$P --format="value(allowPolicyExplanation.allowAccessState)" 2>/dev/null | tail -1 || echo "TROUBLESHOOTER_FAILED"
}

case "${1:-}" in
save)
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  gcloud projects get-iam-policy $P --format=json > "$OUT/project-policy-$ts.json"
  for s in $SERVICES; do
    gcloud run services get-iam-policy "$s" --region=$REGION --project=$P --format=json > "$OUT/service-$s-$ts.json"
    gcloud iam service-accounts get-iam-policy "$(sa "$s")" --project=$P --format=json > "$OUT/account-$s-$ts.json"
  done
  echo "saved the project policy and the 25 services' and accounts' policies to $OUT (*-$ts.json)"
  ;;
grant)
  for s in $SERVICES; do
    gcloud run services add-iam-policy-binding "$s" --region=$REGION --project=$P --member="$MEMBER" --role=roles/run.admin --format=none
    gcloud iam service-accounts add-iam-policy-binding "$(sa "$s")" --project=$P --member="$MEMBER" --role=roles/iam.serviceAccountUser --format=none
    echo "granted $s"
  done
  ;;
verify)
  bad=0
  for s in $SERVICES; do
    gcloud run services get-iam-policy "$s" --region=$REGION --project=$P --format=json \
      | has_binding roles/run.admin || { echo "MISSING unconditional roles/run.admin on $s"; bad=1; }
    gcloud iam service-accounts get-iam-policy "$(sa "$s")" --project=$P --format=json \
      | has_binding roles/iam.serviceAccountUser || { echo "MISSING unconditional roles/iam.serviceAccountUser on $(sa "$s")"; bad=1; }
  done
  [ $bad = 0 ] && echo "all 50 scoped grants present" || { echo "verify FAILED: don't run remove"; exit 1; }
  ;;
remove)
  gcloud projects remove-iam-policy-binding $P --member="$MEMBER" --role=roles/run.admin --condition=None --format=none
  gcloud projects remove-iam-policy-binding $P --member="$MEMBER" --role=roles/iam.serviceAccountUser --condition=None --format=none
  echo "removed project-wide run.admin and iam.serviceAccountUser; wait a few minutes before check"
  ;;
check)
  fail=0
  for s in $W4; do
    u=$(troubleshoot "//run.googleapis.com/projects/$P/locations/$REGION/services/$s" run.services.update)
    a=$(troubleshoot "//iam.googleapis.com/projects/$P/serviceAccounts/$(w4sa "$s")" iam.serviceAccounts.actAs)
    echo "W4 $s: update $u, actAs $a (expected ALLOW_ACCESS_STATE_NOT_GRANTED for both)"
    [ "$u" = ALLOW_ACCESS_STATE_NOT_GRANTED ] && [ "$a" = ALLOW_ACCESS_STATE_NOT_GRANTED ] || fail=1
  done
  for s in $SERVICES; do
    r="//run.googleapis.com/projects/$P/locations/$REGION/services/$s"
    u=$(troubleshoot "$r" run.services.update)
    i=$(troubleshoot "$r" run.services.setIamPolicy)
    a=$(troubleshoot "//iam.googleapis.com/projects/$P/serviceAccounts/$(sa "$s")" iam.serviceAccounts.actAs)
    [ "$u" = ALLOW_ACCESS_STATE_GRANTED ] && [ "$i" = ALLOW_ACCESS_STATE_GRANTED ] && [ "$a" = ALLOW_ACCESS_STATE_GRANTED ] \
      || { echo "legacy $s: update $u, setIamPolicy $i, actAs $a (expected ALLOW_ACCESS_STATE_GRANTED)"; fail=1; }
  done
  [ $fail = 0 ] && echo "check passed: W4 deployment paths denied; the 25 scoped paths granted" || { echo "check FAILED"; exit 1; }
  ;;
test)
  # The serving revision's resolved digest, never the template's tag: a tag
  # is resolved again at deploy time and could name different code.
  rev=$(gcloud run services describe l0158 --region=$REGION --project=$P --format=json | python3 -c '
import json, sys
s = json.load(sys.stdin)["status"]
full = [t for t in s.get("traffic", []) if t.get("percent") == 100]
print((full[0].get("revisionName") if full else None) or "")')
  [ -n "$rev" ] || { echo "l0158 has no single revision serving 100%"; exit 1; }
  image=$(gcloud run revisions describe "$rev" --region=$REGION --project=$P --format="value(status.imageDigest)")
  case "$image" in *@sha256:*) ;; *) echo "revision $rev has no resolved digest ($image)"; exit 1 ;; esac
  # The build must run as the legacy account: assert the project's default
  # build identity before submitting, then record what the build ran as.
  default=$(gcloud builds get-default-service-account --project=$P --format="value(serviceAccountEmail)")
  [ "${default##*/}" = "$LEGACY" ] || { echo "the default build account is ${default##*/}, not $LEGACY; not submitting"; exit 1; }
  echo "redeploying l0158 at $image (serving revision $rev), as the default build account $LEGACY"
  cfg=$(mktemp)
  cat > "$cfg" <<EOF
steps:
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args: ["run", "deploy", "l0158", "--image=$image", "--region=$REGION", "--allow-unauthenticated", "--quiet"]
EOF
  # No serviceAccount in the config, in the global region: the build runs as
  # the default account asserted above, as the legacy deploys do.
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  build=$(gcloud builds submit --no-source --config="$cfg" --region=global --project=$P --async --format="value(id)")
  rm -f "$cfg"
  echo "build $build submitted; waiting for it"
  while :; do
    state=$(gcloud builds describe "$build" --region=global --project=$P --format="value(status)")
    case "$state" in SUCCESS|FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED) break ;; esac
    sleep 10
  done
  gcloud builds describe "$build" --region=global --project=$P --format=json > "$OUT/test-build-$ts.json"
  ran_as=$(gcloud builds describe "$build" --region=global --project=$P --format="value(serviceAccount)")
  echo "build $build: $state; ran as ${ran_as:-the default account (no serviceAccount recorded)}; evidence in $OUT/test-build-$ts.json"
  [ -z "$ran_as" ] || [ "${ran_as##*/}" = "$LEGACY" ] || { echo "the build ran as ${ran_as##*/}, not $LEGACY: the test doesn't count"; exit 1; }
  [ "$state" = SUCCESS ] || { echo "test FAILED: the narrowed account couldn't deploy l0158"; exit 1; }
  echo "test passed: the legacy account deployed l0158 at its serving digest with only the scoped grants"
  ;;
rollback)
  gcloud projects add-iam-policy-binding $P --member="$MEMBER" --role=roles/run.admin --condition=None --format=none
  gcloud projects add-iam-policy-binding $P --member="$MEMBER" --role=roles/iam.serviceAccountUser --condition=None --format=none
  echo "restored the project-wide grants: the gate is OPEN again until the narrowing is redone"
  ;;
*)
  sed -n '2,27p' "$0"
  exit 2
  ;;
esac
