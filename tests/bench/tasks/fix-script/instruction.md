`/app/backup.sh` should copy every `.txt` file of `/app/notes` (subfolders included) into `/app/backup`, keeping the folder structure, and print `backed up N files`. Running `./backup.sh` from `/app` does not work.

Fix the script so that `cd /app && ./backup.sh` works. Do not copy the files yourself: the script must do it.
