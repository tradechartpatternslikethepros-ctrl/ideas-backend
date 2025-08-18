Quick CLI for ideas-backend (likes/comments test)
=============================================================

Files:
- test-likes.sh  — bash script that hits your production backend
- (optional) You can override BASE/TOKEN per run

How to use (macOS/Linux):
1) Make it executable:
   chmod +x test-likes.sh

2) Run it (defaults to your prod env):
   ./test-likes.sh

3) Override for local testing:
   BASE=http://localhost:8080 TOKEN=your_token_here ./test-likes.sh

What it does:
- Creates an idea, grabs the id
- Likes → unlikes → toggles like
- Adds a comment
- Fetches the idea to show updated like/comment counts

Notes:
- Keep your TOKEN secret. Do not commit this script with a real token into a public repo.
