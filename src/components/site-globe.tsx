"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Site Distribution globe (design: executive dashboard "Site Distribution").
 *
 * A dependency-free 3D orthographic globe — hand-rolled projection on a 2D
 * canvas instead of a WebGL library, deliberately: this app ships to
 * satellite-latency mine sites where a three.js bundle (~600KB) would violate
 * the low-bandwidth NFR. ~5KB of math gives the same executive signal:
 * WHERE the portfolio is healthy or bleeding.
 *
 * Performance/a11y contract:
 *  - DPR capped at 2; rAF pauses automatically in background tabs.
 *  - prefers-reduced-motion → static frame (drag still works).
 *  - Canvas unavailable → plain list fallback. Screen readers always get the
 *    hidden list; the canvas is aria-hidden presentation.
 *  - Pointer drag rotates; wheel/scroll is NOT captured.
 */

export interface GlobeSite {
  code: string;
  name: string;
  lat: number;
  lon: number;
  rag: "RED" | "AMBER" | "GREEN";
  projectCount: number;
}

const RAG_COLOR: Record<GlobeSite["rag"], string> = {
  RED: "#DC2626",
  AMBER: "#D97706",
  GREEN: "#059669",
};

const TILT = -0.42; // radians, tips West Africa toward the viewer
const DEG = Math.PI / 180;

interface Projected {
  x: number;
  y: number;
  front: boolean;
  depth: number;
}

function project(
  latDeg: number,
  lonDeg: number,
  rotation: number,
  radius: number,
  cx: number,
  cy: number
): Projected {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG + rotation;
  const x3 = Math.cos(lat) * Math.sin(lon);
  const y3 = Math.sin(lat);
  const z3 = Math.cos(lat) * Math.cos(lon);
  // Tilt about the x-axis so the sphere reads as 3D, not a flat disc.
  const y2 = y3 * Math.cos(TILT) - z3 * Math.sin(TILT);
  const z2 = y3 * Math.sin(TILT) + z3 * Math.cos(TILT);
  return { x: cx + radius * x3, y: cy - radius * y2, front: z2 > 0.02, depth: z2 };
}

export function SiteGlobe({ sites }: { sites: GlobeSite[] }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasOk, setCanvasOk] = useState(true);
  const sitesRef = useRef(sites);
  sitesRef.current = sites;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCanvasOk(false);
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Start centred on West Africa (~4°W).
    let rotation = 4 * DEG;
    let dragging = false;
    let lastX = 0;
    let raf = 0;
    let last = performance.now();

    function draw(now: number) {
      const c = canvasRef.current;
      if (!c || !ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssWidth = c.clientWidth;
      const cssHeight = c.clientHeight;
      if (c.width !== cssWidth * dpr || c.height !== cssHeight * dpr) {
        c.width = cssWidth * dpr;
        c.height = cssHeight * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const dt = Math.min(100, now - last);
      last = now;
      if (!dragging && !reduceMotion) rotation += dt * 0.00006;

      const cx = cssWidth / 2;
      const cy = cssHeight / 2;
      const radius = Math.min(cssWidth, cssHeight) / 2 - 14;

      const styles = getComputedStyle(c);
      const lineColor = `hsl(${styles.getPropertyValue("--border")})`;
      const fillTint = `hsl(${styles.getPropertyValue("--secondary")})`;

      // Sphere disc + limb.
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = fillTint;
      ctx.fill();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      // Graticule: meridians every 30°, parallels every 20°.
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = lineColor;
      for (let lonLine = -180; lonLine < 180; lonLine += 30) {
        ctx.beginPath();
        let pen = false;
        for (let latPt = -88; latPt <= 88; latPt += 4) {
          const p = project(latPt, lonLine, rotation, radius, cx, cy);
          if (p.front) {
            if (pen) ctx.lineTo(p.x, p.y);
            else ctx.moveTo(p.x, p.y);
            pen = true;
          } else pen = false;
        }
        ctx.stroke();
      }
      for (let latLine = -60; latLine <= 60; latLine += 20) {
        ctx.beginPath();
        let pen = false;
        for (let lonPt = -180; lonPt <= 180; lonPt += 4) {
          const p = project(latLine, lonPt, rotation, radius, cx, cy);
          if (p.front) {
            if (pen) ctx.lineTo(p.x, p.y);
            else ctx.moveTo(p.x, p.y);
            pen = true;
          } else pen = false;
        }
        ctx.stroke();
      }

      // Equator slightly stronger for orientation.
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let lonPt = -180; lonPt <= 180; lonPt += 3) {
        const p = project(0, lonPt, rotation, radius, cx, cy);
        if (p.front) {
          if (pen) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
          pen = true;
        } else pen = false;
      }
      ctx.stroke();

      // Site beacons, back-to-front.
      const projected = sitesRef.current
        .map((s) => ({ s, p: project(s.lat, s.lon, rotation, radius, cx, cy) }))
        .sort((a, b) => a.p.depth - b.p.depth);

      for (const { s, p } of projected) {
        if (!p.front) continue;
        const color = RAG_COLOR[s.rag];

        // Pulse ring — red sites pulse noticeably faster.
        if (!reduceMotion) {
          const speed = s.rag === "RED" ? 500 : 1100;
          const phase = (now % speed) / speed;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4 + phase * 10, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.55 * (1 - phase);
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = "500 9px 'JetBrains Mono', monospace";
        ctx.fillStyle = `hsl(${styles.getPropertyValue("--muted-foreground")})`;
        ctx.fillText(`${s.code} (${s.projectCount})`, p.x + 7, p.y + 3);
      }

      raf = requestAnimationFrame(draw);
    }

    function onPointerDown(e: PointerEvent) {
      dragging = true;
      lastX = e.clientX;
      canvas?.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragging) return;
      rotation += (e.clientX - lastX) * 0.005;
      lastX = e.clientX;
    }
    function onPointerUp() {
      dragging = false;
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  const summary = sites
    .map((s) => `${s.name}: ${s.rag.toLowerCase()}, ${s.projectCount} project(s)`)
    .join("; ");

  return (
    <div>
      {canvasOk ? (
        <canvas
          ref={canvasRef}
          aria-hidden
          className="h-56 w-full cursor-grab touch-pan-y active:cursor-grabbing"
        />
      ) : null}
      {/* Always-available accessible representation; visible fallback without canvas. */}
      <ul className={canvasOk ? "sr-only" : "space-y-1 text-sm"} aria-label="Site distribution">
        {sites.map((s) => (
          <li key={s.code}>
            {s.name} — {s.rag}, {s.projectCount} project(s)
          </li>
        ))}
      </ul>
      <p className="sr-only" role="img" aria-label={`Site distribution globe. ${summary}`} />
    </div>
  );
}
