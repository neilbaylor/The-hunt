// Character assets built by tools/character/build.py (inlined into the single-file build).
import neilBin from '../assets/neil/character.bin?url';
import neilSkin from '../assets/neil/skin.jpg?url';
import neilEyes from '../assets/neil/eyes.png?url';
import { loadHuman } from './human';

export const loadNeil = () => loadHuman(neilBin, neilSkin, neilEyes);
