'use client';

import { useEffect, useRef } from 'react';

interface Point {
  x: number;
  y: number;
  oldX: number;
  oldY: number;
  fixed: boolean;
}

const SEGMENTS = 24;
const BASE_REST_LEN = 7.6;
const TIP_REST_LEN = 3.8;
const DAMPING = 0.954;
const BASE_GRAVITY = 0.2;
const TIP_GRAVITY = 0.42;
const ITERATIONS = 12;
const HANDLE_LENGTH = 24;
const HANDLE_OVERHANG = 5;
const HANDLE_ANGLE = Math.PI - 0.08;
const HANDLE_UX = Math.cos(HANDLE_ANGLE);
const HANDLE_UY = Math.sin(HANDLE_ANGLE);
const BASE_EXIT_STRENGTH = 0.1;

/**
 * Sitewide custom cursor - a Verlet-integrated cord attached to a held
 * handle. The cursor sits at the grip; the whip exits from the left end and
 * drapes down-left like the reference silhouette.
 *
 * Bails on touch / prefers-reduced-motion. Hides the native cursor only
 * while this component is mounted and active.
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
    const initAnchor = handleAnchor(initX, initY);
    let segmentX = initAnchor.x;
    let segmentY = initAnchor.y;
    pointsRef.current = Array.from({ length: SEGMENTS }, (_, i) => {
      if (i > 0) {
        const dir = restingDirection(i - 1);
        const restLen = segmentRestLen(i - 1);
        segmentX += dir.x * restLen;
        segmentY += dir.y * restLen;
      }

      return {
        x: segmentX,
        y: segmentY,
        oldX: segmentX,
        oldY: segmentY,
        fixed: i === 0,
      };
    });

    // Inject a global rule that hides the cursor on every element. The
    // browser user-agent stylesheet sets `cursor: pointer` on <button>
    // and <a[href]>, so inline `cursor: none` on <body> isn't enough —
    // children inherit `none` but UA defaults override that for
    // interactive elements. A stylesheet rule at higher specificity
    // covers everything, and unmount removes the tag so the no-JS /
    // reduced-motion fallback is unaffected.
    const styleEl = document.createElement('style');
    styleEl.id = 'day0-whip-cursor-suppress';
    styleEl.textContent = `*, *::before, *::after { cursor: none !important; }`;
    document.head.appendChild(styleEl);

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
      const anchor = handleAnchor(m.x, m.y);

      // Pin the cord to the left end of the held handle.
      // A fast cross-screen swipe lets the trailing cord catch up over time.
      pts[0].x = anchor.x;
      pts[0].y = anchor.y;
      pts[0].oldX = pts[0].x;
      pts[0].oldY = pts[0].y;

      // Verlet integrate the trailing points.
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const t = pointT(i);
        const vx = (p.x - p.oldX) * DAMPING;
        const vy = (p.y - p.oldY) * DAMPING;
        const gravity = lerp(BASE_GRAVITY, TIP_GRAVITY, t);
        p.oldX = p.x;
        p.oldY = p.y;
        p.x += vx;
        p.y += vy + gravity * dt * dt;
      }

      // Constraint solving — Gauss-Seidel, multi-pass.
      for (let iter = 0; iter < ITERATIONS; iter++) {
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const ddx = b.x - a.x;
          const ddy = b.y - a.y;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.001;
          const corr = ((dist - segmentRestLen(i)) / dist) * 0.54;
          if (!a.fixed) {
            a.x += ddx * corr;
            a.y += ddy * corr;
          }
          b.x -= ddx * corr;
          b.y -= ddy * corr;
        }
      }

      const first = pts[1];
      const exitDir = restingDirection(0);
      first.x = lerp(first.x, pts[0].x + exitDir.x * segmentRestLen(0), BASE_EXIT_STRENGTH);
      first.y = lerp(first.y, pts[0].y + exitDir.y * segmentRestLen(0), BASE_EXIT_STRENGTH);

      // Render — clear in CSS pixel space (transform is scaled by dpr).
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const buttX = m.x - HANDLE_UX * HANDLE_OVERHANG;
      const buttY = m.y - HANDLE_UY * HANDLE_OVERHANG;

      ctx.beginPath();
      ctx.moveTo(buttX, buttY);
      ctx.lineTo(anchor.x, anchor.y);
      ctx.strokeStyle = '#1a0e07';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(buttX, buttY);
      ctx.lineTo(anchor.x, anchor.y);
      ctx.strokeStyle = '#a16240';
      ctx.lineWidth = 4.8;
      ctx.stroke();

      for (let i = 0; i < pts.length - 1; i++) {
        const t = segmentT(i);
        const w = segmentWidth(i);
        const alpha = 0.95 - t * 0.48;
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
        ctx.strokeStyle = `rgba(8,17,20,${0.85 - t * 0.25})`;
        ctx.lineWidth = w + 2.1;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
        ctx.strokeStyle = `rgba(34,211,238,${alpha})`;
        ctx.lineWidth = w;
        ctx.stroke();
      }

      // Bright tip dot — the click hotspot.
      const tip = pts[pts.length - 1];
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 1.7, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 0.7, 0, Math.PI * 2);
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
      styleEl.remove();
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

function handleAnchor(gripX: number, gripY: number) {
  return {
    x: gripX + HANDLE_UX * HANDLE_LENGTH,
    y: gripY + HANDLE_UY * HANDLE_LENGTH,
  };
}

function pointT(index: number) {
  return index / (SEGMENTS - 1);
}

function segmentT(index: number) {
  return index / (SEGMENTS - 2);
}

function segmentRestLen(index: number) {
  return lerp(BASE_REST_LEN, TIP_REST_LEN, Math.pow(segmentT(index), 1.4));
}

function restingDirection(index: number) {
  const t = Math.pow(segmentT(index), 0.72);
  const x = lerp(-0.34, -0.08, t);
  const y = lerp(0.94, 1, t);
  const length = Math.sqrt(x * x + y * y) || 1;

  return { x: x / length, y: y / length };
}

function segmentWidth(index: number) {
  return lerp(4.2, 0.72, Math.pow(segmentT(index), 0.7));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
