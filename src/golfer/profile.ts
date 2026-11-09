// Who a golfer is: body, face, outfit and swing personality. Every golfer is built from one of these,
// so adding a friend means adding a profile (and later swapping in their own face texture).

export interface Look {
  skin: string;       // base skin tone
  skinWarm: string;   // cheeks, nose, ears
  lips: string;
  hair: string;
  brows: string;
  eyes: string;       // iris colour
  stubble: number;    // 0 = clean shaven, 1 = full stubble
  hairline: number;   // 0 = low, 1 = high / receding
  faceLength: number; // 1 = average; lean, long faces > 1
  nose: number;       // 1 = average size
  earOut: number;     // how far the ears stand out
}

export interface Headwear {
  kind: 'visor';
  color: string;      // crown band and top of the brim
  under: string;      // underside of the brim
  logo: 'pizza-hut' | null;
}

export interface Outfit {
  top: 'hoodie' | 'polo';
  shirt: string;      // polo colour (realistic body)
  topColor: string;
  topTrim: string;
  emblem: string;     // small chest emblem colour
  pants: string;
  shoes: string;
  shoeTrim: string;
  glove: string;
  chestLogo?: 'malbon-m' | 'toronto-hunt';
  headwear: Headwear | null;
}

export interface SwingStyle {
  tempo: number;      // seconds from address to the top of a full swing
  length: number;     // 1 = shaft parallel at the top
  finishHigh: number; // 1 = a full, high finish
  waggle: boolean;
}

export interface GolferProfile {
  id: string;
  name: string;
  handed: 'left' | 'right';
  heightM: number;
  weightKg: number;
  look: Look;
  outfit: Outfit;
  swing: SwingStyle;
}

// Player 1. Left-handed, 6'3", 180 lb: tall and lean.
// Short dark-brown hair a little high at the temples, blue-grey eyes, light stubble, long lean face,
// strong straight nose. Golf hoodie in heather grey, like the photos, and a retro Pizza Hut tour visor.
export const NEIL: GolferProfile = {
  id: 'neil',
  name: 'Neil',
  handed: 'left',
  heightM: 1.905,
  weightKg: 81.6,
  look: {
    skin: '#e3b49a',
    skinWarm: '#d98f7c',
    lips: '#b9776c',
    hair: '#4a3628',
    brows: '#3a2a1f',
    eyes: '#7d97a8',
    stubble: 0.55,
    hairline: 0.62,
    faceLength: 1.08,
    nose: 1.12,
    earOut: 1.1,
  },
  outfit: {
    top: 'polo',
    shirt: '#1c4739',     // Malbon forest green polo
    topColor: '#d6d3cc',
    topTrim: '#1c4739',
    emblem: '#b3262e',
    pants: '#c8b38a',     // khaki shorts
    shoes: '#f3f2ee',     // white wingtips (classic tour shoe)
    shoeTrim: '#e6e5e0',
    glove: '#f6f5f1',
    chestLogo: 'malbon-m',
    headwear: { kind: 'visor', color: '#f3efe4', under: '#24382b', logo: 'pizza-hut' },
  },
  swing: { tempo: 1.1, length: 1.0, finishHigh: 1.0, waggle: true }, // ≈1.3 s to a full top with the eased approach
};

export const feetInches = (m: number) => {
  const inches = Math.round(m / 0.0254);
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
};
