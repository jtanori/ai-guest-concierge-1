#!/usr/bin/env bash
# W00-11 — Phase B: apply branch protection to `main` on the GitHub remote.
# Requires: gh CLI authenticated with admin on the repo.
# Usage:  ORG=org-name REPO=repo-name ./scripts/protect-main.sh
#
# Acceptance criterion (W00-11): "A direct push to main is rejected".
# After running this, verify with:
#   git push origin main   # from a checkout without an open PR — must be refused (GH006)
set -euo pipefail

: "${ORG:?set ORG}"
: "${REPO:?set REPO}"

API="repos/${ORG}/${REPO}/branches/main/protection"

# PRs required; 1 approving review; dismiss stale reviews; admins bound;
# linear history; required status checks will be appended once CI heads
# exist (W00-12) — 'Require branches to be up to date' stays OFF so W00 PRs
# are not blocked before CI is meaningful.
gh api -X PUT "$API" --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": [] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "main protected on ${ORG}/${REPO}. Add CI check contexts after W00-12 with:"
echo "  gh api -X PUT \"$API/required_status_checks\" -f strict=false -f 'contexts[]=lint' -f 'contexts[]=typecheck' -f 'contexts[]=test'"
