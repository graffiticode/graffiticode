#!/bin/sh
# Reconciles each project in reconcile/projects/ in turn. One project's failure
# doesn't skip the next, but fails the run, so the job's execution shows it.
set -u
status=0
for config in /app/reconcile/projects/*.json; do
  node /app/src/cli.js reconcile-image-tags --config "$config" || status=1
done
exit $status
