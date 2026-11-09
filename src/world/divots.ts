// Impact divots: at impact on an iron shot a strip of turf flies up just ahead of the ball, tumbles along the
// clubhead path, lands a couple of metres on and stays; a fresh scar of bare soil is left where it came from, with a
// puff of grass clippings and soil specks. Out of a bunker it's a spray of sand instead. Everything is pooled
// (one chunk, one scar, one particle set) and persists until clear() — the next ball. Cheap on phones: 3 draw calls.
import * as THREE from 'three';

export interface Divots {
  /**
   * at: the ball's position on the ground; dir: the target direction (xz); club: CLUB_SPECS id ('PW', '7i', '1W'…);
   * lie: LIES name ('Tee box', 'Fairway', 'First cut', 'Rough', 'Fairway bunker'); mode: 'full' | 'punch' | 'pitch' | 'flop';
   * power: 0..1 swing length. Woods, the driver and teed shots take nothing.
   */
  divot(at: THREE.Vector3, dir: THREE.Vector3, club: string, lie: string, mode: string, power?: number, teed?: boolean): void;
  update(dt: number): void;
  clear(): void;
}

/** how big a divot each club takes (1 = a wedge's full strip) and whether it takes any turf at all */
function clubSize(club: string): number {
  if (club === 'PW' || club.endsWith('°') || club === 'GW' || club === 'SW' || club === 'LW') return 1;
  if (club === '9i') return 0.78;
  if (club === '8i') return 0.66;
  if (club === '7i') return 0.45;
  if (club === '6i' || club === '5i' || club === '4i' || club.endsWith('H')) return 0.12; // a bruise and a puff
  return 0;
}

const N_PART = 90;

export function createDivots(scene: THREE.Scene, heightAt: (x: number, z: number) => number): Divots {
  // ── the chunk: a strip of turf, grass on top, dark soil underneath and round the torn sides ──
  const chunkGeo = new THREE.BoxGeometry(1, 1, 1, 4, 1, 6).toNonIndexed();
  {
    const p = chunkGeo.getAttribute('position') as THREE.BufferAttribute, n = chunkGeo.getAttribute('normal');
    const col = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // ragged ends and edges, a slightly domed top
      const rag = 0.08 * Math.sin(z * 23 + x * 7) + 0.06 * Math.sin(x * 31 - z * 11);
      p.setXYZ(i, x * (1 + rag * (Math.abs(z) > 0.45 ? 1.5 : 0.6)), y + (y > 0 ? 0.25 * (0.25 - x * x) : 0), z * (1 + rag * 0.5));
      const top = n.getY(i) > 0.5;
      if (top) c.setRGB(0.12 + 0.05 * Math.sin(x * 40 + z * 13), 0.27 + 0.06 * Math.sin(z * 37), 0.07);
      else c.setRGB(0.085, 0.055, 0.032).multiplyScalar(n.getY(i) < -0.5 ? 0.8 : 1 + 0.15 * Math.sin(z * 50));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    chunkGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    chunkGeo.computeVertexNormals();
  }
  const chunk = new THREE.Mesh(chunkGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  chunk.castShadow = true; chunk.visible = false; chunk.name = 'divot';
  scene.add(chunk);

  // ── the scar: bare soil with a torn, darker edge and a lip of grass roots ──
  const scarTex = (() => {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; const g = cv.getContext('2d')!;
    g.clearRect(0, 0, 64, 128);
    const blob = (r: number, fill: string) => {
      g.beginPath();
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * Math.PI * 2, k = 1 + 0.12 * Math.sin(a * 7 + 1.3) + 0.08 * Math.sin(a * 13);
        const x = 32 + Math.cos(a) * 26 * r * k, y = 64 + Math.sin(a) * 58 * r * k;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.fillStyle = fill; g.fill();
    };
    blob(1.0, 'rgba(48,36,22,0.95)');   // torn edge
    blob(0.84, 'rgba(84,62,40,1)');     // bare soil
    for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '40,28,16' : '120,96,64'},0.6)`; g.fillRect(10 + Math.random() * 44, 14 + Math.random() * 100, 1 + Math.random() * 2, 1 + Math.random() * 2); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const scarGeo = new THREE.PlaneGeometry(1, 1); scarGeo.rotateX(-Math.PI / 2);
  const scar = new THREE.Mesh(scarGeo, new THREE.MeshStandardMaterial({ map: scarTex, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  scar.visible = false; scar.renderOrder = 2; scar.receiveShadow = true; scar.name = 'divot-scar';
  scene.add(scar);

  // ── clippings, soil specks, or sand ──
  const pPos = new Float32Array(N_PART * 3), pCol = new Float32Array(N_PART * 3), pVel = new Float32Array(N_PART * 3), pLive = new Uint8Array(N_PART);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const parts = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.012, vertexColors: true, sizeAttenuation: true }));
  parts.frustumCulled = false; parts.visible = false; parts.name = 'divot-puff';
  scene.add(parts);
  let nParts = 0;

  // chunk flight state
  const vel = new THREE.Vector3(), spin = new THREE.Vector3(), q = new THREE.Quaternion(), dq = new THREE.Quaternion(), e = new THREE.Euler();
  let flying = false, bounces = 0, half = 0.01;
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  return {
    divot(at, dir0, club, lie, mode, power = 1, teed = false) {
      this.clear();
      if (teed) return;
      const dir = new THREE.Vector3(dir0.x, 0, dir0.z).normalize();
      const sand = /bunker|sand/i.test(lie);
      let k = clubSize(club);
      if (k <= 0 && !sand) return;
      const lieK = /tee/i.test(lie) ? 0.5 : /rough/i.test(lie) ? 0.9 : 1;
      const modeK = mode === 'punch' ? 0.85 : mode === 'pitch' ? 0.8 : mode === 'flop' ? 0.9 : 1;
      const thin = mode === 'flop' ? 0.45 : 1;
      const powK = 0.6 + 0.4 * Math.max(0, Math.min(1, power));
      k *= lieK * modeK * powK;
      // a wedge's strip is ~15 x 6 cm and a couple of cm thick (a touch generous so it reads on a phone)
      const L = 0.16 * Math.max(k, 0.25), W = 0.062 * (0.6 + 0.4 * k), T = 0.026 * thin * (0.5 + 0.5 * k);
      const ang = Math.atan2(dir.x, dir.z);
      const c = at.clone().addScaledVector(dir, 0.02 + L * 0.55);
      const gy = heightAt(c.x, c.z);
      // a real strip of turf only for the clubs that take one; long irons just bruise
      const takesChunk = !sand && k > 0.2;
      if (takesChunk) {
        chunk.visible = true;
        chunk.scale.set(W, T, L);
        chunk.position.set(c.x, gy + T * 0.5, c.z);
        e.set(0, ang, 0); q.setFromEuler(e); chunk.quaternion.copy(q);
        // up and forward along the clubhead path, faster for a fuller strike
        vel.copy(dir).multiplyScalar(rnd(3.2, 4.6) * (0.7 + 0.3 * k)).setY(rnd(2.4, 3.4) * (0.75 + 0.25 * k));
        vel.addScaledVector(new THREE.Vector3(dir.z, 0, -dir.x), rnd(-0.4, 0.4));
        spin.set(rnd(10, 18), rnd(-4, 4), rnd(-3, 3));
        flying = true; bounces = 0; half = T * 0.5;
      }
      if (!sand) {
        scar.visible = true;
        scar.scale.set(W * 1.15 * (takesChunk ? 1 : 1.6), 1, L * 1.1 * (takesChunk ? 1 : 0.5));
        scar.position.set(c.x, gy + 0.003, c.z); scar.rotation.set(0, ang, 0);
        (scar.material as THREE.MeshStandardMaterial).opacity = takesChunk ? 1 : 0.55;
      }
      // the puff: grass clippings and soil specks, or a spray of sand from a bunker
      nParts = sand ? N_PART : Math.round(N_PART * (0.35 + 0.65 * Math.min(1, k + 0.2)) * (/rough/i.test(lie) ? 1.2 : 1));
      nParts = Math.min(N_PART, nParts);
      const col = new THREE.Color();
      for (let i = 0; i < N_PART; i++) {
        pLive[i] = i < nParts ? 1 : 0;
        if (!pLive[i]) { pPos[i * 3 + 1] = -1e4; continue; }
        pPos[i * 3] = c.x + rnd(-0.03, 0.03); pPos[i * 3 + 1] = gy + 0.01; pPos[i * 3 + 2] = c.z + rnd(-0.04, 0.04);
        const fwd = sand ? rnd(0.5, 3.5) : rnd(1, 4.5), up = sand ? rnd(1.5, 4.2) : rnd(0.8, 3.2), side = rnd(-1.1, 1.1) * (sand ? 1.4 : 1);
        pVel[i * 3] = dir.x * fwd + dir.z * side; pVel[i * 3 + 1] = up; pVel[i * 3 + 2] = dir.z * fwd - dir.x * side;
        if (sand) col.setRGB(0.62, 0.53, 0.36).multiplyScalar(rnd(0.8, 1.15));
        else if (Math.random() < 0.65) col.setRGB(0.16, 0.32, 0.08).multiplyScalar(rnd(0.8, 1.3));
        else col.setRGB(0.2, 0.13, 0.07).multiplyScalar(rnd(0.8, 1.2));
        pCol[i * 3] = col.r; pCol[i * 3 + 1] = col.g; pCol[i * 3 + 2] = col.b;
      }
      (parts.material as THREE.PointsMaterial).size = sand ? 0.011 : 0.016;
      pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
      parts.visible = nParts > 0;
    },
    update(dt) {
      if (dt <= 0) return;
      const h = Math.min(dt, 1 / 30);
      if (flying) {
        vel.y -= 9.8 * h;
        vel.multiplyScalar(1 - 0.25 * h); // a little air drag on a flat strip
        chunk.position.addScaledVector(vel, h);
        dq.setFromEuler(e.set(spin.x * h, spin.y * h, spin.z * h)); chunk.quaternion.multiply(dq);
        const gy = heightAt(chunk.position.x, chunk.position.z);
        if (chunk.position.y < gy + half) {
          chunk.position.y = gy + half;
          bounces++;
          if (bounces > 2 || Math.abs(vel.y) < 0.6) {
            // settle: lie flat, grass up or soil up as it fell
            flying = false;
            const up = new THREE.Vector3(0, 1, 0).applyQuaternion(chunk.quaternion);
            e.set(up.y >= 0 ? 0 : Math.PI, Math.atan2(vel.x, vel.z) + rnd(-0.4, 0.4), 0); chunk.quaternion.setFromEuler(e);
          } else { vel.y *= -0.25; vel.x *= 0.45; vel.z *= 0.45; spin.multiplyScalar(0.4); }
        }
      }
      if (parts.visible) {
        let moved = false;
        for (let i = 0; i < nParts; i++) {
          if (!pLive[i]) continue;
          const o = i * 3;
          pVel[o + 1] -= 9.8 * h;
          const drag = 1 - 2.2 * h; pVel[o] *= drag; pVel[o + 1] *= drag; pVel[o + 2] *= drag; // clippings flutter down
          pPos[o] += pVel[o] * h; pPos[o + 1] += pVel[o + 1] * h; pPos[o + 2] += pVel[o + 2] * h;
          const gy = heightAt(pPos[o], pPos[o + 2]) + 0.004;
          if (pPos[o + 1] < gy) { pPos[o + 1] = gy; pLive[i] = 0; }
          moved = true;
        }
        if (moved) pGeo.attributes.position.needsUpdate = true;
      }
    },
    clear() {
      chunk.visible = false; scar.visible = false; parts.visible = false; flying = false; nParts = 0;
    },
  };
}
