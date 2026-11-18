// Materials and lights shared by both panes.
import * as THREE from "three";

/** Mesher vertex colours are sRGB-space multipliers (as in Minecraft); linearise them in the shader. */
function linearizeVertexColors(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader.replace(
    "#include <color_vertex>",
    "#include <color_vertex>\n#ifdef USE_COLOR\n\tvColor.rgb = pow( vColor.rgb, vec3( 2.2 ) );\n#endif",
  );
}

export interface BlockMaterials {
  opaque: THREE.Material;
  cutout: THREE.Material;
  translucent: THREE.Material;
}

export function createBlockMaterials(atlas: THREE.Texture): BlockMaterials {
  const make = (params: THREE.MeshLambertMaterialParameters) => {
    const m = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true, ...params });
    m.onBeforeCompile = linearizeVertexColors;
    m.customProgramCacheKey = () => "mc-block";
    return m;
  };
  return {
    opaque: make({}),
    // FrontSide like vanilla: flat models (rails, redstone, ladders, lily pads) carry coplanar
    // up+down faces with mirrored UVs, which z-fight (flicker) when back faces are drawn too.
    // Cross plants model both directions explicitly, so they stay visible from either side.
    cutout: make({ alphaTest: 0.5 }),
    translucent: make({ transparent: true, depthWrite: false, opacity: 1 }),
  };
}

/**
 * LOD heightfield material. Each LOD tile has its own 128x128 colour texture, so there is one
 * material per tile, but they share one program and one set of discard uniforms per world:
 * fragments within `radius` (reference-frame XZ distance) of `center` are discarded, because the
 * full-detail tiles there are already loaded.
 */
export class LodMaterials {
  readonly center = { value: new THREE.Vector2() };
  readonly radius = { value: 0 };

  create(colorTex: THREE.Texture): THREE.MeshLambertMaterial {
    const m = new THREE.MeshLambertMaterial({ map: colorTex });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uFullCenter = this.center;
      shader.uniforms.uFullRadius = this.radius;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vLodXZ;")
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\n\tvLodXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vLodXZ;\nuniform vec2 uFullCenter;\nuniform float uFullRadius;")
        .replace(
          "#include <clipping_planes_fragment>",
          "#include <clipping_planes_fragment>\n\tif ( distance( vLodXZ, uFullCenter ) < uFullRadius ) discard;",
        );
    };
    m.customProgramCacheKey = () => "mc-lod";
    return m;
  }
}

/** Hemisphere + sun. Tuned so an up-facing surface shows its albedo roughly unchanged. */
export function createLights(): THREE.Object3D {
  const g = new THREE.Group();
  const hemi = new THREE.HemisphereLight(
    new THREE.Color().setRGB(1, 1, 1, THREE.LinearSRGBColorSpace),
    new THREE.Color().setRGB(0.3, 0.3, 0.3, THREE.LinearSRGBColorSpace),
    1.95,
  );
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(0.45, 0.8, 0.35).normalize();
  g.add(hemi, sun, sun.target);
  return g;
}
