#!/bin/bash
set -e

# === Config ===
BASE="${BASE:-http://localhost:8080}"
TOKEN="${TOKEN:-4a6ffbf3209fb1392341615d5b6abc6f4db5998a22d825f2615dfd22e3965dfa}"

echo ">>> Using BASE=$BASE"
echo ">>> Using TOKEN=$TOKEN"

# function for curl with auth if needed
curl_auth() {
  curl -s "$@" -H "Authorization: Bearer $TOKEN"
}

# Health check
echo ">>> Checking health..."
curl -s "$BASE/health" | jq . || curl -s "$BASE/health"

# Create idea
echo -e "\n>>> Creating idea..."
IDEA=$(curl_auth -X POST "$BASE/ideas"   -H "Content-Type: application/json"   -d '{"title":"EURUSD breakout","symbol":"EURUSD","summary":"Testing backend"}')
echo "$IDEA" | jq . || echo "$IDEA"

IDEA_ID=$(echo "$IDEA" | jq -r .id)

# List ideas
echo -e "\n>>> Listing ideas..."
curl -s "$BASE/ideas" | jq . || curl -s "$BASE/ideas"

# Toggle like
echo -e "\n>>> Liking idea $IDEA_ID..."
curl_auth -X POST "$BASE/ideas/$IDEA_ID/like/toggle" | jq . || true

# Add comment
echo -e "\n>>> Adding comment..."
COMMENT=$(curl_auth -X POST "$BASE/ideas/$IDEA_ID/comments"   -H "Content-Type: application/json"   -d '{"text":"This is a test comment"}')
echo "$COMMENT" | jq . || echo "$COMMENT"

COMMENT_ID=$(echo "$COMMENT" | jq -r .id)

# List comments
echo -e "\n>>> Listing comments..."
curl -s "$BASE/ideas/$IDEA_ID/comments" | jq . || curl -s "$BASE/ideas/$IDEA_ID/comments"

# Edit comment
echo -e "\n>>> Editing comment $COMMENT_ID..."
curl_auth -X PATCH "$BASE/ideas/$IDEA_ID/comments/$COMMENT_ID"   -H "Content-Type: application/json"   -d '{"text":"This is an edited test comment"}' | jq . || true

# Final list
echo -e "\n>>> Final ideas list..."
curl -s "$BASE/ideas" | jq . || curl -s "$BASE/ideas"

# Optional cleanup
if [ "$CLEANUP" = "1" ]; then
  echo -e "\n>>> Deleting idea $IDEA_ID..."
  curl_auth -X DELETE "$BASE/ideas/$IDEA_ID" | jq . || true
fi
