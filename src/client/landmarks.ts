// Jump-to presets, in reference-frame (sf) block coords. y omitted = ground + a little.
export interface Landmark {
  name: string;
  x: number | null; // null = coordinates unknown (shown disabled)
  z: number | null;
  y?: number;
  yaw?: number;
  pitch?: number;
}

/** sf world spawn (from the save) with the yaw the replica's authors use. */
export const SF_SPAWN = { x: 1520, y: -50, z: 3730, yaw: -58 };

export const LANDMARKS: Landmark[] = [
  { name: "Spawn (street level)", x: SF_SPAWN.x, z: SF_SPAWN.z, y: SF_SPAWN.y + 1.62, yaw: SF_SPAWN.yaw, pitch: 0 },
  { name: "Spawn, overview", x: SF_SPAWN.x, z: SF_SPAWN.z, y: SF_SPAWN.y + 600, yaw: SF_SPAWN.yaw, pitch: 50 },
  // Camera poses looking at each landmark. Positions come from real lat/lon through arnis's local
  // projection and the arnis->sf alignment (spike/landmarks.py), checked against sf geometry:
  // towers snapped to their tallest block (Salesforce top y=279, Sutro 500, Transamerica 213).
  { name: "Ferry Building", x: 1442, y: -4, z: 3860, yaw: -135, pitch: 4 },
  { name: "Transamerica Pyramid", x: 1428, y: 80, z: 3171, yaw: -135, pitch: 0 },
  { name: "Salesforce Tower", x: 685, y: 113, z: 3638, yaw: -135, pitch: 0 },
  { name: "Coit Tower", x: 2363, y: 84, z: 2926, yaw: -135, pitch: 8 },
  { name: "Sutro Tower", x: -2311, y: 316, z: -1800, yaw: -135, pitch: -4 },
  { name: "Twin Peaks", x: -2366, y: 341, z: -1496, yaw: -135, pitch: 33 },
  { name: "Golden Gate Park", x: -641, y: 468, z: -4116, yaw: -135, pitch: 28 },
  { name: "Painted Ladies (Alamo Sq)", x: -87, y: 57, z: 88, yaw: -135, pitch: 23 },
  { name: "City Hall", x: -13, y: 56, z: 1389, yaw: -135, pitch: 11 },
  { name: "Oracle Park", x: -531, y: 39, z: 4008, yaw: -135, pitch: 19 },
  { name: "Lombard St (crooked)", x: 2565, y: 76, z: 1766, yaw: -135, pitch: 31 },
  { name: "Palace of Fine Arts", x: 3015, y: 12, z: -750, yaw: -135, pitch: 20 },
  { name: "Golden Gate Bridge (south)", x: 3815, y: 178, z: -2758, yaw: -135, pitch: 25 },
  { name: "Mission Dolores", x: -1461, y: 22, z: 389, yaw: -135, pitch: 23 },
];
