// DOM overlays: pane labels, divider, HUD, settings/jump panel, help.
import { config } from "./config.ts";
import { type Landmark, LANDMARKS } from "./landmarks.ts";

/** How the two worlds share the canvas. A diff-tint mode can slot in here later. */
export enum ViewMode {
  SideBySide = "side",
  Swipe = "swipe",
}

export interface UICallbacks {
  onRadius(r: number): void;
  onJump(x: number, z: number, y: number | null): void;
  onLandmark(l: Landmark): void;
  onViewMode(m: ViewMode): void;
  onSplit(x: number): void;
  onToggleControls(): void;
  extraLandmarks: Landmark[];
}

const HELP = `
<h2>Controls</h2>
<table>
<tr><td>Click</td><td>capture mouse (fly mode); Esc releases</td></tr>
<tr><td>Mouse / drag</td><td>look</td></tr>
<tr><td>W A S D</td><td>move (W/S follow the view direction)</td></tr>
<tr><td>Space / E</td><td>up</td></tr>
<tr><td>Q / Ctrl</td><td>down (Q is safer: Ctrl+W closes the tab)</td></tr>
<tr><td>Shift</td><td>6x faster</td></tr>
<tr><td>Wheel</td><td>base speed (fly) / zoom (map)</td></tr>
<tr><td>Tab</td><td>fly &harr; map mode (map: left-drag pan, right-drag rotate)</td></tr>
<tr><td>V</td><td>side by side &harr; swipe (drag the divider)</td></tr>
<tr><td>F3</td><td>show/hide debug info</td></tr>
<tr><td>H</td><td>this help</td></tr>
</table>
<p>Speed grows with height above ground. The URL hash holds the view (<code>#x,y,z,yaw,pitch</code>) &mdash; copy the URL to share it.
Query: <code>?a=sf&amp;b=arnis&amp;r=384&amp;data=&lt;base url&gt;</code>.</p>
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export class UI {
  readonly labelA = el("div", { class: "pane-label" });
  readonly labelB = el("div", { class: "pane-label" });
  readonly divider = el("div", { id: "divider" });
  readonly hud = el("pre", { id: "hud", class: localStorage.getItem("mcr.debug") === "1" ? "" : "hidden" });
  readonly help = el("div", { id: "help", class: "hidden" }, HELP);
  readonly status = el("div", { id: "status", class: "hidden" });
  /** Required data attribution (OSM ODbL, arnis sources); see CREDITS.md. */
  readonly credits = el(
    "div",
    { id: "credits" },
    'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL) &middot; ' +
      'arnis world: Overture Maps, Mapterhorn, USGS 3DEP, ESA WorldCover, Meta/WRI canopy &middot; ' +
      '<a href="https://github.com/amichaelyu/minecraft_world_compare/blob/master/CREDITS.md" target="_blank" rel="noopener">credits</a> &middot; ' +
      "Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.",
  );
  private readonly modeBtn: HTMLButtonElement;
  private readonly ctrlBtn: HTMLButtonElement;
  private viewMode = ViewMode.SideBySide;

  /** Debug HUD (coords, tiles, fps): hidden by default, F3 or the "debug" button toggles, remembered. */
  get debugVisible(): boolean {
    return !this.hud.classList.contains("hidden");
  }

  toggleDebug(): void {
    this.hud.classList.toggle("hidden");
    localStorage.setItem("mcr.debug", this.debugVisible ? "1" : "0");
  }

  constructor(root: HTMLElement, cb: UICallbacks) {
    const panel = el("div", { id: "panel" });

    const rLabel = el("label", {}, `radius <span>${config.radius}</span>`);
    const r = el("input", {
      type: "range",
      min: String(config.radiusMin),
      max: String(config.radiusMax),
      step: "64",
      value: String(config.radius),
    });
    r.addEventListener("input", () => {
      rLabel.querySelector("span")!.textContent = r.value;
      cb.onRadius(Number(r.value));
    });
    r.addEventListener("keydown", (e) => e.stopPropagation());

    const jump = el("input", { type: "text", placeholder: "x, z  or  x, y, z", size: "16" });
    const go = el("button", {}, "go");
    const doJump = () => {
      const n = jump.value.split(/[\s,]+/).filter(Boolean).map(Number);
      if (n.some((v) => !Number.isFinite(v)) || (n.length !== 2 && n.length !== 3)) {
        jump.classList.add("bad");
        return;
      }
      jump.classList.remove("bad");
      if (n.length === 2) cb.onJump(n[0]!, n[1]!, null);
      else cb.onJump(n[0]!, n[2]!, n[1]!);
      jump.blur();
    };
    go.addEventListener("click", doJump);
    jump.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJump();
      if (e.key === "Escape") jump.blur();
    });

    const sel = el("select");
    const all = [...LANDMARKS, ...cb.extraLandmarks];
    sel.append(el("option", { value: "" }, "landmarks…"));
    all.forEach((l, i) => {
      const o = el("option", { value: String(i) }, l.x === null ? `${l.name} (TODO)` : l.name);
      if (l.x === null) o.disabled = true;
      sel.append(o);
    });
    sel.addEventListener("change", () => {
      const l = all[Number(sel.value)];
      if (sel.value !== "" && l) cb.onLandmark(l);
      sel.value = "";
      sel.blur();
    });

    this.modeBtn = el("button", { title: "V" }, "swipe view");
    this.modeBtn.addEventListener("click", () => this.toggleViewMode(cb));
    this.ctrlBtn = el("button", { title: "Tab" }, "map mode");
    this.ctrlBtn.addEventListener("click", () => cb.onToggleControls());
    const helpBtn = el("button", { title: "H" }, "help");
    helpBtn.addEventListener("click", () => this.help.classList.toggle("hidden"));
    const debugBtn = el("button", { title: "F3" }, "debug");
    debugBtn.addEventListener("click", () => this.toggleDebug());

    const row = (...c: HTMLElement[]) => {
      const d = el("div", { class: "row" });
      d.append(...c);
      return d;
    };
    panel.append(row(rLabel, r), row(jump, go, sel), row(this.ctrlBtn, this.modeBtn, helpBtn, debugBtn));
    root.append(this.labelA, this.labelB, this.divider, this.hud, panel, this.help, this.status, this.credits);

    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT") return;
      if (e.code === "KeyH") this.help.classList.toggle("hidden");
      if (e.code === "F3") {
        e.preventDefault();
        this.toggleDebug();
      }
      if (e.code === "KeyV") this.toggleViewMode(cb);
    });

    // dragging the divider (swipe mode)
    let drag = false;
    this.divider.addEventListener("pointerdown", (e) => {
      if (this.viewMode !== ViewMode.Swipe) return;
      drag = true;
      this.divider.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    this.divider.addEventListener("pointermove", (e) => drag && cb.onSplit(e.clientX));
    this.divider.addEventListener("pointerup", () => (drag = false));
  }

  private toggleViewMode(cb: UICallbacks): void {
    this.viewMode = this.viewMode === ViewMode.SideBySide ? ViewMode.Swipe : ViewMode.SideBySide;
    this.modeBtn.textContent = this.viewMode === ViewMode.Swipe ? "side-by-side view" : "swipe view";
    this.divider.classList.toggle("swipe", this.viewMode === ViewMode.Swipe);
    cb.onViewMode(this.viewMode);
  }

  setControlMode(mode: string): void {
    this.ctrlBtn.textContent = mode === "fly" ? "map mode" : "fly mode";
  }

  setLabels(a: string, b: string): void {
    this.labelA.textContent = a;
    this.labelB.textContent = b;
  }

  /** Place divider and labels; split = x (CSS px) of the boundary between A and B. */
  layout(split: number, width: number): void {
    this.divider.style.left = `${split}px`;
    this.labelA.style.left = `${split / 2}px`;
    this.labelB.style.left = `${split + (width - split) / 2}px`;
  }

  setStatus(text: string | null): void {
    this.status.classList.toggle("hidden", !text);
    this.status.textContent = text ?? "";
  }
}
