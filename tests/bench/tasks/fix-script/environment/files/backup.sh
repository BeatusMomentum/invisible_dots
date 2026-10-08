#/bin/bash
# Copies the notes into backup.
count=0
for f in $(find notes -name *.txt); do
  mkdir -p backup/$(dirname $f)
  cp $f backup/$f
  count=$count+1
done
echo "backed up $count files"
