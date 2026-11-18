// Builds a blocky heightfield mesh for one MCL1 LOD tile: greedy-merged flat tops per height,
// vertical walls where neighbouring cells differ, and skirts at the tile border / around missing
// cells so tiles of different levels don't show cracks. Colours come from a 128x128 texture
// (one texel per cell), so tops of equal height merge regardless of colour.
import * as THREE from "three";
import { LOD_CELLS, LOD_NO_DATA } from "../shared/api.ts";
import type { DecodedLod } from "../shared/tile-format.ts";

const N = LOD_CELLS;
/** LOD surfaces sit a hair below the block top so full-detail geometry wins where both exist. */
const SURFACE_EPS = 0.06;

class QuadBuilder {
  pos = new Float32Array(4096 * 12);
  nrm = new Int8Array(4096 * 12);
  uv = new Float32Array(4096 * 8);
  quads = 0;

  private grow(): void {
    const g = <T extends Float32Array | Int8Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos);
    this.nrm = g(this.nrm);
    this.uv = g(this.uv);
  }

  /**
   * Corners p0..p3 in cyclic order, each [x,y,z,u,v]; (nx,ny,nz) the outward normal (-1/0/1).
   * Winding is fixed up from the normal.
   */
  quad(c: number[], nx: number, ny: number, nz: number): void {
    if ((this.quads + 1) * 12 > this.pos.length) this.grow();
    // geometric normal of (p0,p1,p2)
    const ax = c[5]! - c[0]!, ay = c[6]! - c[1]!, az = c[7]! - c[2]!;
    const bx = c[10]! - c[0]!, by = c[11]! - c[1]!, bz = c[12]! - c[2]!;
    const gx = ay * bz - az * by, gy = az * bx - ax * bz, gz = ax * by - ay * bx;
    const flip = gx * nx + gy * ny + gz * nz < 0;
    const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
    let p = this.quads * 12, t = this.quads * 8;
    for (const k of order) {
      const o = k * 5;
      this.pos[p] = c[o]!;
      this.pos[p + 1] = c[o + 1]!;
      this.pos[p + 2] = c[o + 2]!;
      this.nrm[p] = nx * 127;
      this.nrm[p + 1] = ny * 127;
      this.nrm[p + 2] = nz * 127;
      this.uv[t] = c[o + 3]!;
      this.uv[t + 1] = c[o + 4]!;
      p += 3;
      t += 2;
    }
    this.quads++;
  }

  geometry(): THREE.BufferGeometry {
    const nv = this.quads * 4;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos.slice(0, nv * 3), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(this.nrm.slice(0, nv * 3), 3, true));
    geo.setAttribute("uv", new THREE.BufferAttribute(this.uv.slice(0, nv * 2), 2));
    const idx = nv > 65535 ? new Uint32Array(this.quads * 6) : new Uint16Array(this.quads * 6);
    for (let q = 0, i = 0; q < this.quads; q++) {
      const v = q * 4;
      idx[i++] = v;
      idx[i++] = v + 1;
      idx[i++] = v + 2;
      idx[i++] = v;
      idx[i++] = v + 2;
      idx[i++] = v + 3;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }
}

export interface LodTileMesh {
  geometry: THREE.BufferGeometry;
  texture: THREE.DataTexture;
  minH: number;
  maxH: number;
}

/** Valid heights (LOD_NO_DATA where the cell has no data). */
export function validHeights(lod: DecodedLod): Int16Array {
  const h = new Int16Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = lod.colors[i * 4 + 3] === 0 ? LOD_NO_DATA : lod.heights[i]!;
  return h;
}

export function buildLodMesh(lod: DecodedLod, H: Int16Array): LodTileMesh | null {
  const c = 2 ** lod.level;
  let minH = Infinity,
    maxH = -Infinity;
  for (let i = 0; i < N * N; i++) {
    const h = H[i]!;
    if (h === LOD_NO_DATA) continue;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  if (minH === Infinity) return null;

  const qb = new QuadBuilder();
  const top = (h: number) => h + 1 - SURFACE_EPS;
  const skirtY = minH + 1 - Math.max(8, 4 * c);

  // Tops: greedy rectangles of equal height.
  const seen = new Uint8Array(N * N);
  for (let cz = 0; cz < N; cz++) {
    for (let cx = 0; cx < N; cx++) {
      const i = cz * N + cx;
      const h = H[i]!;
      if (seen[i] || h === LOD_NO_DATA) continue;
      let w = 1;
      while (cx + w < N && !seen[i + w] && H[i + w] === h) w++;
      let d = 1;
      grow: while (cz + d < N) {
        const r = (cz + d) * N + cx;
        for (let k = 0; k < w; k++) if (seen[r + k] || H[r + k] !== h) break grow;
        d++;
      }
      for (let z = 0; z < d; z++) seen.fill(1, (cz + z) * N + cx, (cz + z) * N + cx + w);
      const y = top(h);
      const x0 = cx * c, x1 = (cx + w) * c, z0 = cz * c, z1 = (cz + d) * c;
      const u0 = cx / N, u1 = (cx + w) / N, v0 = cz / N, v1 = (cz + d) / N;
      qb.quad([x0, y, z0, u0, v0, x0, y, z1, u0, v1, x1, y, z1, u1, v1, x1, y, z0, u1, v0], 0, 1, 0);
    }
  }

  // Walls. For a boundary between cells a (lower index side) and b, return [bottom, top, side]
  // where side = +1 if the wall faces +axis (a is the higher/solid one), -1 if it faces -axis.
  const wall = (ha: number, hb: number): [number, number, number] | null => {
    const va = ha !== LOD_NO_DATA, vb = hb !== LOD_NO_DATA;
    if (va && vb) {
      if (ha === hb) return null;
      return ha > hb ? [top(hb), top(ha), 1] : [top(ha), top(hb), -1];
    }
    if (va) return [skirtY, top(ha), 1];
    if (vb) return [skirtY, top(hb), -1];
    return null;
  };

  // Walls on vertical lines x = X*c (between cells X-1 and X), merged along z.
  for (let X = 0; X <= N; X++) {
    let run: [number, number, number] | null = null;
    let runStart = 0;
    const flush = (end: number) => {
      if (!run) return;
      const [b, t, s] = run;
      const x = X * c, z0 = runStart * c, z1 = end * c;
      const u = (s > 0 ? X - 1 + 0.5 : X + 0.5) / N, v0 = runStart / N, v1 = end / N;
      qb.quad([x, b, z0, u, v0, x, t, z0, u, v0, x, t, z1, u, v1, x, b, z1, u, v1], s, 0, 0);
      run = null;
    };
    for (let cz = 0; cz < N; cz++) {
      const ha = X > 0 ? H[cz * N + X - 1]! : LOD_NO_DATA;
      const hb = X < N ? H[cz * N + X]! : LOD_NO_DATA;
      const w = wall(ha, hb);
      if (run && (!w || w[0] !== run[0] || w[1] !== run[1] || w[2] !== run[2])) flush(cz);
      if (w && !run) {
        run = w;
        runStart = cz;
      }
    }
    flush(N);
  }

  // Walls on horizontal lines z = Z*c (between cells Z-1 and Z), merged along x.
  for (let Z = 0; Z <= N; Z++) {
    let run: [number, number, number] | null = null;
    let runStart = 0;
    const flush = (end: number) => {
      if (!run) return;
      const [b, t, s] = run;
      const z = Z * c, x0 = runStart * c, x1 = end * c;
      const v = (s > 0 ? Z - 1 + 0.5 : Z + 0.5) / N, u0 = runStart / N, u1 = end / N;
      qb.quad([x0, b, z, u0, v, x0, t, z, u0, v, x1, t, z, u1, v, x1, b, z, u1, v], 0, 0, s);
      run = null;
    };
    for (let cx = 0; cx < N; cx++) {
      const ha = Z > 0 ? H[(Z - 1) * N + cx]! : LOD_NO_DATA;
      const hb = Z < N ? H[Z * N + cx]! : LOD_NO_DATA;
      const w = wall(ha, hb);
      if (run && (!w || w[0] !== run[0] || w[1] !== run[1] || w[2] !== run[2])) flush(cx);
      if (w && !run) {
        run = w;
        runStart = cx;
      }
    }
    flush(N);
  }

  const geometry = qb.geometry();
  const size = N * c;
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(0, skirtY, 0), new THREE.Vector3(size, maxH + 1, size));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());

  const texture = new THREE.DataTexture(lod.colors, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { geometry, texture, minH, maxH };
}
