Build a small key-value database server in `/app/kv`. `/app/kv/start.sh` must start it in the background on 127.0.0.1 port 7070, write the server's process id to `/app/kv/server.pid`, and return once the server answers. It keeps its data in `/app/kv/data`.

Its HTTP API:
- `PUT /keys/<key>` stores the request body (any bytes, up to 2 MB) as the key's value: 201 when the key was new, 200 when it replaced a value. A header `X-TTL: <seconds>` makes the key expire that many seconds later;
- `GET /keys/<key>`: 200 with the value exactly as stored, or 404 (also once the key expired);
- `DELETE /keys/<key>`: 204, or 404 when there is no such key;
- `GET /keys?prefix=<p>`: 200 with a JSON array of the live keys starting with `p`, sorted;
- `GET /stats`: 200 with `{"keys": <number of live keys>}`.

A key in the URL is percent-encoded (it may hold `/` or spaces). Many clients may write at once.

Durability: once a `PUT` or `DELETE` has been answered, its effect must survive the server being killed with `kill -9` at any moment, and `start.sh` being run again.
