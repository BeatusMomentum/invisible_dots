# Benchmarks on real Dots

Agent benchmarks run on real Dots: each task gets a new Dot, its own computer
is set up the way the task says, the Dot is given the task through the API,
and the task's grader checks what is left on that computer. The runs use
[Harbor](https://github.com/harbor-framework/harbor) (Apache-2.0), the harness
of Terminal-Bench, with the Dot as its environment and its agent, so our own
tasks and Harbor's benchmarks run the same way.

TEST HARNESS ONLY: nothing here is part of the product.

## How a Dot runs a Harbor task

| Harbor | Here |
|---|---|
| environment | `dots_harbor/environment.py`: a new Dot per trial, created through the API with the CPU and memory the task asks for, every permission allowed (nobody is there to answer an approval), deleted after the trial |
| the task's `environment/Dockerfile` | replayed in the Dot's computer as its user `dot` (`dots_harbor/dockerfile.py`): `apt-get install` becomes `sudo dot-install`, `pip install` goes to dot's user site, `COPY` uploads, `WORKDIR` and `ENV` are followed |
| `/app`, `/tests`, `/solution`, `/logs` | moved under `/home/dot/bench` (`dots_harbor/paths.py`), in commands, uploaded text files and the instruction: the model's user has no root, and the host reaches only dot's home |
| agent | `dots_harbor/agent.py`: the instruction is sent to the Dot as a task; the Dot works with its own tools until the task ends; its spend is the trial's cost |
| `oracle` and `nop` | Harbor's own: the task's reference solution, or nothing |

Every call to the product goes through `bridge.ts`, which uses the end-to-end
run's outside driver (`tests/e2e/driver.ts`): the HTTP API and dot-agentd on a
running computer.

A task that needs root in its computer cannot run in a Dot. Its oracle fails,
which is how such a task is found: **a task counts only once its oracle scores
1 and `nop` scores 0 in a Dot.**

## The tasks

`tasks/` holds our own suite, 25 tasks written by `author.py` (run it with
the directory to write to; the data is generated with a fixed seed and the
expected answers are computed there, never by the agent). Each grader is
`tests/grade.py`, run by `tests/test.sh`.

| Category | Tasks |
|---|---|
| shell | `top-ips`, `large-files`, `fix-script`, `user-service` |
| files and documents | `csv-to-json`, `organize-downloads`, `extract-emails`, `invoice-report` |
| coding | `fix-pagination`, `wordfreq-cli`, `bash-to-python`, `git-history` |
| data analysis | `sales-by-region`, `temperature-stats`, `join-orders` |
| the computer's settings | `git-identity`, `ssh-config` |
| questions with one answer | `meeting-speaker`, `recipes-question`, `shipment-weights` |
| long tasks (45 minutes allowed) | `static-site`, `log-pipeline` |
| what a Dot is for | `automation-tick` (its own automation must run twice), `careful-cleanup` (remove the leftovers and nothing else), `impossible-request` (it must say it cannot) |

The oracle of `automation-tick` cannot use the Dot's automations, which belong
to the Dot: it writes the two lines the grader checks itself.

## Running

In the bench container: the end-to-end run's Linux host plus Python and
Harbor (`Dockerfile`), on the same volumes, so the images the end-to-end run
built are used. Build `idots-linux-host` first (`tests/e2e/README.md`), prepare
`/work/dots` with `prepare.sh` as for the end-to-end run, then:

```bash
docker build -t idots-bench tests/bench
docker run -d --init --name idots-bench \
  --device /dev/kvm --group-add "$(stat -c %g /dev/kvm)" \
  -v "$PWD:/src:ro" -v ~/openrouter.key:/run/secrets/openrouter:ro \
  -v idots-e2e-home:/data -v idots-e2e-work:/work \
  -e INVISIBLE_DOTS_HOME=/data/home idots-bench sleep infinity

# The tasks are sound: the oracle scores 1 on each, doing nothing scores 0.
docker exec -w /work/dots -e E2E_OPENROUTER_KEY_FILE=/run/secrets/openrouter idots-bench \
  bash tests/bench/run.sh oracle -p tests/bench/tasks -n 4
docker exec -w /work/dots -e E2E_OPENROUTER_KEY_FILE=/run/secrets/openrouter idots-bench \
  bash tests/bench/run.sh nop -p tests/bench/tasks -n 4

# The Dot does them; -k 3 runs each three times (pass rate per task).
docker exec -w /work/dots -e E2E_OPENROUTER_KEY_FILE=/run/secrets/openrouter \
  -e BENCH_MODEL=z-ai/glm-5.3-flash idots-bench \
  bash tests/bench/run.sh dot -p tests/bench/tasks -n 4 -k 3
```

`run.sh` starts the server, stores the key, runs `harbor run` with the Dot
environment and stops the server. The arguments after the agent are
`harbor run`'s: `-p` a task or a folder of tasks, `-d terminal-bench@2.0` a
dataset of Harbor's registry, `-n` the trials at once, `-k` the attempts per
task, `-i`/`-x` to include or exclude tasks. Results go to `BENCH_JOBS_DIR`
(default `/work/bench-jobs`): `harbor view` shows them.

| Variable | Default | |
|---|---|---|
| `BENCH_MODEL` | `z-ai/glm-5.3-flash` | the Dot's model (OpenRouter id) |
| `BENCH_MAX_STEPS` | 150 | the Dot's `limits.max_steps_per_task` |
| `BENCH_MAX_COST_USD` | 3 | the Dot's `limits.max_cost_per_task_usd` |

## External benchmarks

Harbor's registry datasets run the same way, for instance Terminal-Bench 2.0
(89 shell, coding and system tasks):

```bash
docker exec -w /work/dots -e E2E_OPENROUTER_KEY_FILE=/run/secrets/openrouter idots-bench \
  bash tests/bench/run.sh oracle -d terminal-bench@2.0 -n 4
```

Run the oracle first: the tasks whose oracle fails in a Dot (they need root, a
program dot-install cannot give, or a path outside the mapped roots) are left
out of the Dot's run with `-x`.
