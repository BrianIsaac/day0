'use client';

import { useEffect, useRef } from 'react';

interface Point {
  x: number;
  y: number;
  oldX: number;
  oldY: number;
  fixed: boolean;
}

const SEGMENTS = 22;
const REST_LEN = 13;
const DAMPING = 0.96;
const GRAVITY = 0.45;
const ITERATIONS = 6;
const HANDLE_FRACTION = 0.18;

/**
 * Sitewide custom cursor — a Verlet-integrated rope that trails the mouse
 * with whip-like physics. The head is pinned to the pointer; the body
 * lags behind, the tip flicks on mousedown.
 *
 * Bails on touch / prefers-reduced-motion. Hides the native cursor only
 * while this component is mounted and active, so the static SVG fallback
 * still applies if JavaScript fails to load.
 */
export function WhipCursor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -200, y: -200 });
  const pointsRef = useRef<Point[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      window.matchMedia('(pointer: coarse)').matches
    ) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    const initX = window.innerWidth / 2;
    const initY = window.innerHeight / 2;
    pointsRef.current = Array.from({ length: SEGMENTS }, (_, i) => ({
      x: initX,
      y: initY + i * REST_LEN,
      oldX: initX,
      oldY: initY + i * REST_LEN,
      fixed: i === 0,
    }));

    const prevHtmlCursor = document.documentElement.style.cursor;
    const prevBodyCursor = document.body.style.cursor;
    document.documentElement.style.cursor = 'none';
    document.body.style.cursor = 'none';

    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
    };

    const onMouseDown = () => {
      // Velocity burst on click: pull the tip's "previous" position
      // backward along the current direction so Verlet integration
      // interprets it as a sudden lunge — produces a visible flick.
      const pts = pointsRef.current;
      if (pts.length < 3) return;
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      last.oldX = last.x - dx * 6;
      last.oldY = last.y - dy * 6;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);

    let lastTs = performance.now();
    const loop = (ts: number) => {
      const dt = Math.min((ts - lastTs) / 16.67, 2.5);
      lastTs = ts;

      const pts = pointsRef.current;
      const m = mouseRef.current;

      // Pin head to mouse, but cap displacement per frame so a
      // fast cross-screen swipe doesn't snap the rope into a stretched
      // line — the body catches up over a few frames instead.
      const hdx = m.x - pts[0].x;
      const hdy = m.y - pts[0].y;
      const hd = Math.sqrt(hdx * hdx + hdy * hdy);
      const maxStep = REST_LEN * 4;
      if (hd > maxStep) {
        pts[0].x += (hdx / hd) * maxStep;
        pts[0].y += (hdy / hd) * maxStep;
      } else {
        pts[0].x = m.x;
        pts[0].y = m.y;
      }
      pts[0].oldX = pts[0].x;
      pts[0].oldY = pts[0].y;

      // Verlet integrate the trailing points.
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const vx = (p.x - p.oldX) * DAMPING;
        const vy = (p.y - p.oldY) * DAMPING;
        p.oldX = p.x;
        p.oldY = p.y;
        p.x += vx;
        p.y += vy + GRAVITY * dt;
      }

      // Constraint solving — Gauss-Seidel, multi-pass.
      for (let iter = 0; iter < ITERATIONS; iter++) {
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const ddx = b.x - a.x;
          const ddy = b.y - a.y;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.001;
          const corr = ((dist - REST_LEN) / dist) * 0.5;
          if (!a.fixed) {
            a.x += ddx * corr;
            a.y += ddy * corr;
          }
          b.x -= ddx * corr;
          b.y -= ddy * corr;
        }
      }

      // Render — clear in CSS pixel space (transform is scaled by dpr).
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i < pts.length - 1; i++) {
        const t = i / (pts.length - 1);
        const w = 9 * (1 - t * 0.95) + 0.6;
        let color: string;
        if (t < HANDLE_FRACTION) {
          // Handle — warm brown
          const ht = t / HANDLE_FRACTION;
          color = `rgba(161,98,64,${0.95 - ht * 0.05})`;
        } else {
          // Body → tip — cyan accent fading
          const bt = (t - HANDLE_FRACTION) / (1 - HANDLE_FRACTION);
          const alpha = 0.95 - bt * 0.55;
          color = `rgba(34,211,238,${alpha})`;
        }
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
        ctx.strokeStyle = color;
        ctx.lineWidth = w;
        ctx.stroke();
      }

      // Bright tip dot — the click hotspot.
      const tip = pts[pts.length - 1];
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 1, 0, Math.PI * 2);
      ctx.fillStyle = '#0a0a0b';
      ctx.fill();

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('resize', resize);
      document.documentElement.style.cursor = prevHtmlCursor;
      document.body.style.cursor = prevBodyCursor;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />
  );
}
