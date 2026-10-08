FROM ubuntu:24.04
WORKDIR /app
COPY files/ /app/
RUN python3 gen.py && rm gen.py
