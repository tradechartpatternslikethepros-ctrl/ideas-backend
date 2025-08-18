{\rtf1\ansi\ansicpg1252\cocoartf2822
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 #!/bin/bash\
set -e\
\
BASE="http://localhost:8080"\
TOKEN="4a6ffbf3209fb1392341615d5b6abc6f4db5998a22d825f2615dfd22e3965dfa"\
\
echo "\uc0\u55357 \u56589  Health check..."\
curl -s "$BASE/health" | jq .\
\
echo\
echo "\uc0\u55357 \u56541  Creating a new idea..."\
CREATE=$(curl -sX POST "$BASE/ideas" \\\
  -H "Authorization: Bearer $TOKEN" \\\
  -H "Content-Type: application/json" \\\
  -d '\{"title":"Test EURUSD","symbol":"EURUSD","summary":"Automated test idea"\}')\
\
echo "$CREATE" | jq .\
ID=$(echo "$CREATE" | jq -r .id)\
\
echo\
echo "\uc0\u55357 \u56481  Created idea with ID: $ID"\
\
echo\
echo "\uc0\u55357 \u56397  Toggling like..."\
curl -sX POST "$BASE/ideas/$ID/like/toggle" | jq .\
\
echo\
echo "\uc0\u55357 \u56492  Adding a comment..."\
COMMENT=$(curl -sX POST "$BASE/ideas/$ID/comments" \\\
  -H "Authorization: Bearer $TOKEN" \\\
  -H "Content-Type: application/json" \\\
  -d '\{"text":"Nice setup!"\}')\
echo "$COMMENT" | jq .\
\
echo\
echo "\uc0\u55357 \u56515  Fetching comments..."\
curl -s "$BASE/ideas/$ID/comments" | jq .\
\
echo\
echo "\uc0\u55357 \u56514  Listing all ideas..."\
curl -s "$BASE/ideas" | jq .\
}