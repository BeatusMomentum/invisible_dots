Write a small HTTP server `/app/server.py` (Python standard library only) that answers `GET /health` with status 200 and the JSON body `{"status": "ok"}`, and any other path with 404.

Then start it so that it keeps running in the background after you finish, listening on 127.0.0.1 port 8765, and write its process id to `/app/server.pid`.
