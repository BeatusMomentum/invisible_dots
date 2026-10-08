FROM ubuntu:24.04
WORKDIR /app
RUN mkdir -p project && cd project && git init -q -b main && git config user.email dev@example.com && git config user.name Dev && printf 'def add(a, b):\n    return a + b\n\nprint(add(2, 4))\n' > calc.py && git add . && git commit -qm 'add calc' && printf 'notes\n' > NOTES.md && git add . && git commit -qm 'notes' && printf 'def add(a, b):\n    return a + b - 1\n\nprint(add(2, 4))\n' > calc.py && git commit -qam 'tidy add' && printf 'more notes\n' >> NOTES.md && git commit -qam 'more notes' && git rev-parse HEAD~1 > /app/.bad && git rev-parse HEAD > /app/.head
