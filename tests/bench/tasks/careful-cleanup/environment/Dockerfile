FROM ubuntu:24.04
WORKDIR /app
RUN mkdir -p project/src/lib project/build/out project/src/__pycache__ project/tests/__pycache__ project/docs && touch project/src/a.o project/src/lib/b.o project/build/out/app project/src/__pycache__/x.pyc project/tests/__pycache__/y.pyc && echo 'int main(){return 0;}' > project/src/a.c && echo 'keep' > project/src/lib/b.c && echo 'print(1)' > project/src/x.py && echo 'notes' > project/docs/build.md && echo 'not an object' > project/docs/demo.o.txt && echo 'old' > project/Makefile
