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
      | grep -q "\"$MEMBER\"" || { echo "MISSING run.admin on $s"; bad=1; }
    gcloud iam service-accounts get-iam-policy "$(sa "$s")" --project=$P --format=json \
      | grep -q "\"$MEMBER\"" || { echo "MISSING serviceAccountUser on $(sa "$s")"; bad=1; }
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
    u=$(troubleshoot "//run.googleapis.com/projects/$P/locations/$REGION/services/$s" run.services.setIamPolicy)
    a=$(troubleshoot "//iam.googleapis.com/projects/$P/serviceAccounts/$(sa "$s")" iam.serviceAccounts.actAs)
    [ "$u" = ALLOW_ACCESS_STATE_GRANTED ] && [ "$a" = ALLOW_ACCESS_STATE_GRANTED ] || { echo "legacy $s: setIamPolicy $u, actAs $a (expected ALLOW_ACCESS_STATE_GRANTED)"; fail=1; }
  done
  [ $fail = 0 ] && echo "check passed: W4 deployment paths denied; the 25 scoped paths granted" || { echo "check FAILED"; exit 1; }
  ;;
test)
  image=$(gcloud run services describe l0158 --region=$REGION --project=$P --format="value(spec.template.spec.containers[0].image)")
  [ -n "$image" ] || { echo "no image for l0158"; exit 1; }
  cfg=$(mktemp)
  cat > "$cfg" <<EOF
steps:
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args: ["run", "deploy", "l0158", "--image=$image", "--region=$REGION", "--allow-unauthenticated", "--quiet"]
EOF
  # No serviceAccount in the config: the build runs as the legacy account, as its deploys do.
  gcloud builds submit --no-source --config="$cfg" --project=$P
  rm -f "$cfg"
  echo "redeployed l0158's current image as the legacy account"
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
