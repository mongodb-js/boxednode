#/bin/bash

set -e

TEMPLATE_FILE=.github/workflows/nodejs.yml.in
OUTPUT_FILE=.github/workflows/nodejs.yml
TEST_SUITE=test/index.ts

rm $OUTPUT_FILE

echo "# This is a generated file. Please change $TEMPLATE_FILE" > $OUTPUT_FILE
echo "# and run the following command to update the GHA Workflow" >> $OUTPUT_FILE
echo "# $> npm run update-gha-workflow" >> $OUTPUT_FILE
echo "# --------------------" >> $OUTPUT_FILE

# This AWK script seems complicated, but it's actually really simple:
# 1. It grabs all the lines with the "it" function
# 2. Removes quotes (single quotes and backticks)
# 3. If it contains a $, assumes it's a literal template, so keeps everything before the $ (for name matching)
# 4. Iterates over all matches and generates a single-line JSON array.
RESULT=$(awk '
/it\(/ {
    s = $0
    sub(/.*it\(\s*['\''`"]/, "", s)
    if (s ~ /\$/) sub(/\$.*/, "", s)
    sub(/['\''`"].*/, "", s)
    names[++n] = s
}
END {
    printf "["
    for (i = 1; i <= n; i++) { printf "\"%s\"%s", names[i], (i < n ? "," : "") }
    print "]"
}
' $TEST_SUITE)

sed "s/<<TEST_NAMES>>/$RESULT/g" $TEMPLATE_FILE >> $OUTPUT_FILE
