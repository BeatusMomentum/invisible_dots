# The benchmark's host (tests/bench/README.md): the end-to-end run's stand-in Linux host
# (tests/e2e/linux-host/Dockerfile, built first as idots-linux-host) plus Python and Harbor, which drive
# the benchmarks. TEST HARNESS ONLY. Harbor stays out of the host image itself, which holds exactly what
# a person installs for the product.
FROM idots-linux-host
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/harbor \
 && /opt/harbor/bin/pip install --no-cache-dir harbor==0.24.0
ENV PATH=/opt/harbor/bin:$PATH
USER dots
WORKDIR /work
