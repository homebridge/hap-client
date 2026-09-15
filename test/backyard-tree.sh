#!/usr/bin/env bash
set -euo pipefail

# Requires curl and jq. Homebridge must run in insecure mode (-I).
# Use the IP:port discovered for bridge 69:62:B7:AE:38:D4.
# Read once: HAP_PIN=031-45-154 bash test/backyard-tree.sh http://192.168.1.10:51826
# Poll every 5 seconds: append --watch to the command above.
if [[ $# -lt 1 || $# -gt 2 || (${2:-} != '' && ${2:-} != '--watch') ]]; then
  echo "Usage: HAP_PIN=xxx-xx-xxx bash $0 http://BRIDGE_IP:PORT [--watch]" >&2
  exit 1
fi
: "${HAP_PIN:?Set HAP_PIN to the PIN for bridge 69:62:B7:AE:38:D4}"
command -v jq >/dev/null || { echo 'This script requires jq.' >&2; exit 1; }
base_url=${1%/}

# HAP IDs vary between installations, so look them up by service name and type.
accessories_response=$(curl --fail --silent --show-error --max-time 15 \
  --header "Authorization: $HAP_PIN" "$base_url/accessories")
printf 'Full /accessories response:\n%s\n' "$accessories_response"
characteristic_id=$(printf '%s\n' "$accessories_response" | jq -er '
  def hap_type($short):
    ascii_upcase | . == $short or . == ("000000" + $short + "-0000-1000-8000-0026BB765291");
  [ .accessories[] as $accessory
    | $accessory.services[]
    | select(.type | hap_type("8A"))
    | select(any(.characteristics[]; (.type | hap_type("23")) and .value == "Backyard Tree")
        or any($accessory.services[];
          (.type | hap_type("3E")) and any(.characteristics[];
            (.type | hap_type("23")) and .value == "Backyard Tree")))
    | .characteristics[]
    | select(.type | hap_type("11"))
    | "\($accessory.aid).\(.iid)"
  ] | unique
  | if length == 1 then .[0]
    else error("Expected exactly one Backyard Tree temperature characteristic; found \(length)")
    end
')

while true; do
  response=$(curl --fail --silent --show-error --max-time 15 \
    --header "Authorization: $HAP_PIN" \
    "$base_url/characteristics?id=$characteristic_id")
  printf 'Full /characteristics response:\n%s\n' "$response"
  temperature=$(printf '%s\n' "$response" | jq -er '
    .characteristics[0]
    | if (.status // 0) != 0 then error("HAP status: \(.status)")
      elif .value == null then error("No temperature returned")
      else .value end
  ')
  echo "$(date '+%Y-%m-%d %H:%M:%S') Backyard Tree: $temperature °C"
  if [[ ${2:-} != '--watch' ]]; then
    break
  fi
  sleep 5
done
