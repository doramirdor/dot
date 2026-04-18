#!/usr/bin/env node
/**
 * scripts/gen-character-svgs.mjs
 *
 * Generate one static SVG per character in src/renderer/characters.ts.
 * Outputs to assets/characters/<id>.svg. Used for the README and any
 * future docs site.
 *
 * The BODY + LEAF pixel arrays are duplicated from src/renderer/Pet.tsx
 * because this script is intentionally zero-dependency — no TS compile,
 * no build step. If you change Pet.tsx's sprite, mirror it here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO = path.resolve(__dirname, '..')
const OUT = path.join(REPO, 'assets', 'characters')
fs.mkdirSync(OUT, { recursive: true })

const GRID = 16
const CELL = 16 // larger than Pet.tsx (8) so the static SVGs look good in README

const FIXED = {
  outline: '#1a1a2e',
  cheek: '#ffb5c5',
  eyeWhite: '#fffdf5',
  pupil: '#1a1a2e',
  leafDark: '#2b7a3e',
  leafMid: '#8dd080',
  leafLight: '#b5e4a8',
  stem: '#3b5323',
  gold: '#ffd56b',
  sleep: '#9fe0f5',
}

const LEAF = [
  [7, 0, 'leafDark'],
  [8, 0, 'leafDark'],
  [6, 1, 'leafDark'],
  [7, 1, 'leafLight'],
  [8, 1, 'leafMid'],
  [9, 1, 'leafDark'],
  [5, 2, 'leafDark'],
  [6, 2, 'leafLight'],
  [7, 2, 'leafMid'],
  [8, 2, 'leafMid'],
  [9, 2, 'leafMid'],
  [10, 2, 'leafDark'],
  [7, 3, 'stem'],
  [8, 3, 'stem'],
]

const BODY = [
  // row 4
  [5, 4, 'outline'], [6, 4, 'outline'], [7, 4, 'outline'], [8, 4, 'outline'], [9, 4, 'outline'], [10, 4, 'outline'],
  // row 5
  [4, 5, 'outline'], [5, 5, 'bodyLight'], [6, 5, 'body'], [7, 5, 'body'], [8, 5, 'body'], [9, 5, 'body'], [10, 5, 'bodyShade'], [11, 5, 'outline'],
  // row 6
  [3, 6, 'outline'], [4, 6, 'bodyLight'], [5, 6, 'body'], [6, 6, 'body'], [7, 6, 'body'], [8, 6, 'body'], [9, 6, 'body'], [10, 6, 'body'], [11, 6, 'bodyShade'], [12, 6, 'outline'],
  // row 7
  [3, 7, 'outline'], [4, 7, 'body'], [5, 7, 'body'], [6, 7, 'body'], [7, 7, 'body'], [8, 7, 'body'], [9, 7, 'body'], [10, 7, 'body'], [11, 7, 'body'], [12, 7, 'outline'],
  // row 8
  [3, 8, 'outline'], [4, 8, 'body'], [5, 8, 'body'], [6, 8, 'body'], [7, 8, 'body'], [8, 8, 'body'], [9, 8, 'body'], [10, 8, 'body'], [11, 8, 'body'], [12, 8, 'outline'],
  // row 9
  [3, 9, 'outline'], [4, 9, 'body'], [5, 9, 'body'], [6, 9, 'body'], [7, 9, 'body'], [8, 9, 'body'], [9, 9, 'body'], [10, 9, 'body'], [11, 9, 'body'], [12, 9, 'outline'],
  // row 10
  [3, 10, 'outline'], [4, 10, 'body'], [5, 10, 'body'], [6, 10, 'body'], [7, 10, 'body'], [8, 10, 'body'], [9, 10, 'body'], [10, 10, 'body'], [11, 10, 'body'], [12, 10, 'outline'],
  // row 11
  [3, 11, 'outline'], [4, 11, 'bodyShade'], [5, 11, 'body'], [6, 11, 'body'], [7, 11, 'body'], [8, 11, 'body'], [9, 11, 'body'], [10, 11, 'body'], [11, 11, 'bodyShade'], [12, 11, 'outline'],
  // row 12
  [4, 12, 'outline'], [5, 12, 'bodyShade'], [6, 12, 'body'], [7, 12, 'body'], [8, 12, 'body'], [9, 12, 'body'], [10, 12, 'bodyShade'], [11, 12, 'outline'],
  // row 13
  [5, 13, 'outline'], [6, 13, 'bodyShade'], [7, 13, 'bodyShade'], [8, 13, 'bodyShade'], [9, 13, 'bodyShade'], [10, 13, 'outline'],
  // row 14
  [6, 14, 'outline'], [7, 14, 'outline'], [8, 14, 'outline'], [9, 14, 'outline'],
]

// Static face — a generic idle expression baked in for the README thumbnail.
// Uses the same coords as Pet.tsx's getExpression('idle') but inlined.
function face(palette) {
  return [
    // left eye white
    [5, 7, palette.eyeWhite], [6, 7, palette.eyeWhite], [5, 8, palette.eyeWhite], [6, 8, palette.eyeWhite],
    // left pupil
    [6, 8, palette.pupil],
    // right eye white
    [9, 7, palette.eyeWhite], [10, 7, palette.eyeWhite], [9, 8, palette.eyeWhite], [10, 8, palette.eyeWhite],
    // right pupil
    [9, 8, palette.pupil],
    // cheeks
    [4, 9, palette.cheek], [11, 9, palette.cheek],
    // mouth
    [7, 10, palette.pupil], [8, 10, palette.pupil],
  ]
}

const characters = [
  { id: 'dot', label: 'Dot', seedling: { bodyLight: '#b5e4a8', body: '#8dd080', bodyShade: '#5fa05a' }, adult: { bodyLight: '#c5ecf7', body: '#9fe0f5', bodyShade: '#6cc0e8' } },
  { id: 'dot-sleepy', label: 'Sleepy Dot', seedling: { bodyLight: '#d8d0e8', body: '#b5a8d0', bodyShade: '#7a6eaa' }, adult: { bodyLight: '#cfc8e6', body: '#a79dd3', bodyShade: '#6e649f' } },
  { id: 'dot-focused', label: 'Focused Dot', seedling: { bodyLight: '#a8d8d8', body: '#6eb5b5', bodyShade: '#3e8a8a' }, adult: { bodyLight: '#b0e6e6', body: '#74c5c5', bodyShade: '#3e9a9a' } },
  { id: 'dot-excited', label: 'Excited Dot', seedling: { bodyLight: '#ffd8a8', body: '#ff9a5a', bodyShade: '#cc6a2e' }, adult: { bodyLight: '#ffe0b8', body: '#ffae6a', bodyShade: '#cc7236' } },
  { id: 'dot-concerned', label: 'Concerned Dot', seedling: { bodyLight: '#ffc8c0', body: '#e86a5c', bodyShade: '#a83a2e' }, adult: { bodyLight: '#ffb8b0', body: '#d95c50', bodyShade: '#9a2e24' } },
  { id: 'dot-playful', label: 'Playful Dot', seedling: { bodyLight: '#ffd6eb', body: '#ff9ecb', bodyShade: '#cc5ea0' }, adult: { bodyLight: '#ffc8e6', body: '#ff8ec2', bodyShade: '#c4548c' } },
  { id: 'dot-rainbow', label: 'Rainbow Dot', seedling: { bodyLight: '#ffe6a8', body: '#c8a8ff', bodyShade: '#7a5ec8' }, adult: { bodyLight: '#ffe6c0', body: '#b892ff', bodyShade: '#6a4eb8' } },
]

function renderSvg(paletteBody, includeLeaf, bgGradient) {
  const palette = { ...FIXED, ...paletteBody }
  const pixels = []
  if (includeLeaf) {
    for (const [x, y, key] of LEAF) pixels.push([x, y, FIXED[key]])
  }
  for (const [x, y, key] of BODY) pixels.push([x, y, palette[key]])
  for (const p of face(palette)) pixels.push(p)

  const size = GRID * CELL
  const h = size + CELL * 2

  const rects = pixels
    .map(([x, y, fill]) => `<rect x="${x * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}" fill="${fill}"/>`)
    .join('')

  const bg = bgGradient
    ? `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${bgGradient[0]}"/><stop offset="100%" stop-color="${bgGradient[1]}"/></linearGradient></defs><rect width="${size}" height="${h}" rx="24" fill="url(#bg)"/>`
    : `<rect width="${size}" height="${h}" rx="24" fill="#f8f9fc"/>`
  const shadow = `<ellipse cx="${size * 0.5}" cy="${size * 0.97}" rx="${size * 0.24}" ry="${CELL * 0.6}" fill="rgba(0,0,0,0.22)"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${h}" width="${size}" height="${h}" shape-rendering="crispEdges">${bg}${shadow}${rects}</svg>`
}

for (const c of characters) {
  // Two variants per character: seedling (pre-onboarding) + adult (post).
  fs.writeFileSync(
    path.join(OUT, `${c.id}-seedling.svg`),
    renderSvg(c.seedling, true, ['#fff', '#f0f2f8']),
  )
  fs.writeFileSync(
    path.join(OUT, `${c.id}-adult.svg`),
    renderSvg(c.adult, false, ['#fff', '#f0f2f8']),
  )
}

// A combined hero image showing all seven adult forms in a row.
const HERO_CELL = 14
const HERO_BODY_SIZE = GRID * HERO_CELL
const HERO_H = HERO_BODY_SIZE + HERO_CELL * 2
const HERO_W = HERO_BODY_SIZE * characters.length + 40 * (characters.length - 1)

const heroChildren = characters
  .map((c, i) => {
    const palette = { ...FIXED, ...c.adult }
    const x0 = i * (HERO_BODY_SIZE + 40)
    const rects = BODY.map(([x, y, key]) =>
      `<rect x="${x0 + x * HERO_CELL}" y="${y * HERO_CELL}" width="${HERO_CELL}" height="${HERO_CELL}" fill="${palette[key]}"/>`,
    )
    const faceRects = face(palette).map(([x, y, fill]) =>
      `<rect x="${x0 + x * HERO_CELL}" y="${y * HERO_CELL}" width="${HERO_CELL}" height="${HERO_CELL}" fill="${fill}"/>`,
    )
    const shadow = `<ellipse cx="${x0 + HERO_BODY_SIZE * 0.5}" cy="${HERO_BODY_SIZE * 0.97}" rx="${HERO_BODY_SIZE * 0.24}" ry="${HERO_CELL * 0.6}" fill="rgba(0,0,0,0.22)"/>`
    const label = `<text x="${x0 + HERO_BODY_SIZE * 0.5}" y="${HERO_BODY_SIZE + HERO_CELL * 1.6}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" fill="#555">${c.label}</text>`
    return shadow + rects.join('') + faceRects.join('') + label
  })
  .join('')

const hero = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${HERO_W} ${HERO_H + 28}" width="${HERO_W}" height="${HERO_H + 28}" shape-rendering="crispEdges"><rect width="${HERO_W}" height="${HERO_H + 28}" fill="#fafbfe"/>${heroChildren}</svg>`
fs.writeFileSync(path.join(OUT, 'cast.svg'), hero)

console.log(`wrote ${characters.length * 2 + 1} files to ${OUT}`)
