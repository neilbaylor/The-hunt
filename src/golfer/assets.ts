// Character assets built by tools/character/build.py and head.py (inlined into the single-file build).
import neilBin from '../assets/neil/character.bin?url';
import neilSkin from '../assets/neil/skin.jpg?url';
import neilSmile from '../assets/neil/skin_smile.jpg?url';
import neilEyes from '../assets/neil/eyes.png?url';
import neilHead from '../assets/neil/head.bin?url';
import neilHeadTex from '../assets/neil/head.jpg?url';
import { loadHumanWithHead } from './human';

// head.bin/head.jpg: the generated head from tools/character/head.py
export const loadNeil = () => loadHumanWithHead(neilBin, neilSkin, neilEyes, neilSmile, neilHead, neilHeadTex);
