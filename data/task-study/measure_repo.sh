#!/bin/bash
# Usage: measure_repo.sh owner/repo
# Outputs a tab-separated line:
# repo  stars  created_at  default_branch  earliest_release_tag  earliest_release_date  commits_to_release  commits_total  merged_prs_to_release  merged_prs_total  contributors_approx

set -uo pipefail
if [[ -z "${GH_TOKEN:-}" ]]; then
  export GH_TOKEN
  GH_TOKEN=$(gh auth token 2>/dev/null)
fi
REPO="$1"

info=$(gh api "repos/$REPO" 2>/dev/null) || { echo -e "$REPO\tERROR_REPO_NOT_FOUND"; exit 0; }
stars=$(echo "$info" | jq -r '.stargazers_count')
created=$(echo "$info" | jq -r '.created_at')
default_branch=$(echo "$info" | jq -r '.default_branch')
desc=$(echo "$info" | jq -r '.description // "" ' | tr '\n' ' ')

# Get releases (non-draft), sorted ascending by created_at -> earliest
releases=$(gh api "repos/$REPO/releases" --paginate 2>/dev/null | jq -r '[.[] | select(.draft==false)] | sort_by(.created_at) | if length>0 then .[0] | "\(.tag_name)\t\(.created_at)" else "\t" end' 2>/dev/null)
tag=$(echo "$releases" | cut -f1)
tag_date=$(echo "$releases" | cut -f2)

if [[ -z "$tag" ]]; then
  # fallback to tags endpoint (no reliable date without extra lookups); use most recent-listed tag name only, mark date NA
  tags_json=$(gh api "repos/$REPO/tags" --paginate 2>/dev/null)
  tag=$(echo "$tags_json" | jq -r '.[0].name // empty' 2>/dev/null)
  tag_date="NA"
fi
[[ -z "$tag_date" ]] && tag_date="NA"
[[ -z "$tag" ]] && tag="NA"

# function: commit count reachable from a ref via Link header trick
count_commits() {
  local ref="$1"
  local hdrs
  hdrs=$(gh api -i "repos/$REPO/commits?sha=${ref}&per_page=1" 2>/dev/null)
  local link
  link=$(echo "$hdrs" | grep -i '^link:' || true)
  if [[ -z "$link" ]]; then
    # no Link header means only 1 page -> count via array length of body
    local body
    body=$(echo "$hdrs" | sed -n '/^\[/,$p')
    local n
    n=$(echo "$body" | jq 'length' 2>/dev/null)
    echo "${n:-NA}"
  else
    local last
    last=$(echo "$link" | grep -oE 'page=[0-9]+>; rel="last"' | grep -oE '[0-9]+' || true)
    echo "${last:-NA}"
  fi
}

commits_total=$(count_commits "$default_branch")
if [[ -n "$tag" && "$tag" != "null" ]]; then
  commits_to_release=$(count_commits "$tag")
else
  commits_to_release="NA"
fi

# merged PR count via search, capped at 1000 by API but fine for our use
count_merged_prs() {
  local until_date="$1"
  local q="repo:${REPO} type:pr is:merged"
  if [[ -n "$until_date" && "$until_date" != "NA" ]]; then
    local d="${until_date%%T*}"
    q="$q merged:<=$d"
  fi
  local out attempt=0
  while (( attempt < 5 )); do
    out=$(gh api -X GET "search/issues" -f q="$q" --jq '.total_count' 2>/dev/null)
    if [[ "$out" =~ ^[0-9]+$ ]]; then
      echo "$out"
      return 0
    fi
    attempt=$((attempt+1))
    sleep 5
  done
  echo "NA"
}

merged_prs_total=$(count_merged_prs "")
sleep 2
if [[ -n "$tag_date" && "$tag_date" != "NA" && "$tag_date" != "null" ]]; then
  merged_prs_to_release=$(count_merged_prs "$tag_date")
else
  merged_prs_to_release="NA"
fi

# contributor count approx via Link header trick
contrib_hdrs=$(gh api -i "repos/$REPO/contributors?per_page=1&anon=0" 2>/dev/null)
contrib_link=$(echo "$contrib_hdrs" | grep -i '^link:' || true)
if [[ -z "$contrib_link" ]]; then
  contributors=$(echo "$contrib_hdrs" | sed -n '/^\[/,$p' | jq 'length' 2>/dev/null)
else
  contributors=$(echo "$contrib_link" | grep -oE 'page=[0-9]+>; rel="last"' | grep -oE '[0-9]+' || true)
fi

echo -e "${REPO}\t${stars}\t${created}\t${default_branch}\t${tag:-NA}\t${tag_date:-NA}\t${commits_to_release:-NA}\t${commits_total:-NA}\t${merged_prs_to_release:-NA}\t${merged_prs_total:-NA}\t${contributors:-NA}\t${desc}"
