#!/usr/bin/env bash
set -euo pipefail

# You can override these per-run:
#   BASE=http://localhost:8080 TOKEN=your_token ./test-likes.sh
BASE="${BASE:-https://ideas-backend-production.up.railway.app}"
TOKEN="${TOKEN:-4a6ffbf3209fb1392341615d5b6abc6f4db5998a22d825f2615dfd22e3965dfa}"

echo "1) Creating idea on $BASE ..."
RESP="$(curl -s -X POST "$BASE/ideas"   -H "Authorization: Bearer $TOKEN"   -H "Content-Type: application/json"   -d '{"title":"CLI Prod Test","symbol":"OANDA:XAUUSD","type":"idea"}')"
echo "Create response: $RESP"

ID="$(printf '%s' "$RESP" | sed -n 's/.*\"id\":\"\([^\"]*\)\".*/\1/p')"
if [ -z "${ID}" ]; then
  echo "!! Could not parse idea id from response" >&2
  exit 1
fi
echo "-> ID: $ID"

echo
echo "2) Like (no auth needed because PUBLIC_LIKES=true) ..."
curl -s -X POST "$BASE/likes"   -H 'Content-Type: application/json'   -d "{"id":"$ID","like":true}" | tee /dev/stderr
echo

echo
echo "3) Unlike ..."
curl -s -X POST "$BASE/likes"   -H 'Content-Type: application/json'   -d "{"id":"$ID","like":false}" | tee /dev/stderr
echo

echo
echo "4) Toggle like (should flip) ..."
curl -s -X POST "$BASE/likes/toggle"   -H 'Content-Type: application/json'   -d "{"id":"$ID"}" | tee /dev/stderr
echo

echo
echo "5) Add a comment (auth required for comments) ..."
curl -s -X POST "$BASE/ideas/$ID/comments"   -H "Authorization: Bearer $TOKEN"   -H 'Content-Type: application/json'   -d '{"text":"Nice setup 👌"}' | tee /dev/stderr
echo

echo
echo "6) Fetch idea to verify likeCount/commentCount ..."
curl -s "$BASE/ideas/$ID" | sed 's/,/,\n/g'
echo

echo "Done ✅"
