#!/bin/bash
# fincmp.sh name "extra qs" : held finish from the Rory camera, next to Rory (mirrored)
D=/tmp/claude-0/-home-user/2315be70-f187-593e-a2dc-f420a899e84c/scratchpad
node $D/shot.mjs $D/shots/$1.png "pose=held&club=${CLUB:-0}&tee=0.037&view=finishfront$2" 400 600 2>&1 | grep -v 404
python3 -c "
from PIL import Image
r=Image.open('/home/user/the-hunt/tools/refs/swing/rory_finish.jpg').crop((855,0,1280,720)).transpose(Image.FLIP_LEFT_RIGHT).resize((400,678))
a=Image.open('$D/shots/$1.png').crop((0,0,400,600)); a=a.crop((40,0,360,560)).resize((400,700)).crop((0,0,400,678))
o=Image.new('RGB',(800,678),'white'); o.paste(r,(0,0)); o.paste(a,(400,0)); o.save('$D/shots/$1_cmp.png')"
