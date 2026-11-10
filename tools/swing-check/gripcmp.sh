#!/bin/bash
# gripcmp.sh name "qs1" "qs2" ... : gripeye + gripfront for each qs, side by side
D=/tmp/claude-0/-home-user/2315be70-f187-593e-a2dc-f420a899e84c/scratchpad; n=$1; shift; fs=()
i=0; for q in "$@"; do for v in gripeye gripfront; do f=$D/shots/_g$i$v.png; node $D/shot.mjs $f "pose=${POSE:-address}&club=6&view=$v&$q" 400 400 2>&1 | grep -v 404 >/dev/null; fs+=($f); done; i=$((i+1)); done
python3 -c "
import sys
from PIL import Image
fs=sys.argv[2:]; o=Image.new('RGB',(400*len(fs),400)); [o.paste(Image.open(f),(i*400,0)) for i,f in enumerate(fs)]; o.save(sys.argv[1])" $D/shots/$n.png "${fs[@]}"; echo $D/shots/$n.png
