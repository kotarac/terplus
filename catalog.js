// Copyright (C) 2026 Stipe Kotarac
// SPDX-License-Identifier: OFL-1.1

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import * as path from 'node:path'
import * as zlib from 'node:zlib'

function numericFields(source, name, count) {
  assert(typeof source === 'string' && typeof name === 'string' && Number.isInteger(count))
  const match = source.match(new RegExp(`^${name} ([-0-9 ]+)$`, 'm'))
  assert(match, `Missing ${name}`)
  const values = match[1].trim().split(/\s+/).map(Number)
  assert(values.length === count && values.every(Number.isSafeInteger), `Invalid ${name}`)
  return values
}

function parseGlyph(match, cell, boundary) {
  assert(match && cell.length === 4 && boundary > 0)
  const block = match[0]
  const [code] = numericFields(block, 'ENCODING', 1)
  assert(code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff))
  const box = numericFields(block, 'BBX', 4)
  const advance = numericFields(block, 'DWIDTH', 2)
  assert.deepEqual(box, cell, 'Expected a full-cell bitmap')
  assert.deepEqual(advance, [cell[0], 0], 'Expected a fixed cell advance')
  const bitmap = block.match(/^BITMAP\n([\s\S]*?)\nENDCHAR$/m)
  assert(bitmap, `Missing bitmap: ${code}`)
  const rows = bitmap[1].split('\n')
  const digits = Math.ceil(cell[0] / 8) * 2
  assert(rows.length === cell[1] && rows.every((row) => new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(row)), `Invalid bitmap: ${code}`)
  return { code, name: match[1], added: match.index > boundary, rows }
}

async function readFont(filename) {
  assert(typeof filename === 'string' && /^terplus-u\d+[nb]\.bdf$/.test(filename))
  const source = (await fs.readFile(path.resolve(import.meta.dirname, filename), 'utf8')).replaceAll('\r\n', '\n')
  const cell = numericFields(source, 'FONTBOUNDINGBOX', 4)
  assert(cell[0] > 0 && cell[0] <= 32 && cell[1] > 0)
  const marker = 'COMMENT End of Terminus glyphs. Terplus additions follow.'
  const boundary = source.indexOf(marker)
  assert(boundary > 0 && boundary === source.lastIndexOf(marker), `Invalid section marker: ${filename}`)
  const glyphs = [...source.matchAll(/^STARTCHAR (\S+)\n[\s\S]*?^ENDCHAR$/gm)].map((match) => parseGlyph(match, cell, boundary))
  assert(glyphs.length === numericFields(source, 'CHARS', 1)[0] && glyphs.length > 0)
  assert(new Set(glyphs.map((glyph) => glyph.code)).size === glyphs.length, `Repeated encoding: ${filename}`)
  glyphs.sort((left, right) => left.code - right.code)
  const weight = { n: 'Normal', b: 'Bold' }[filename.at(-5)]
  assert(weight)
  return { id: filename.slice(0, -4), width: cell[0], height: cell[1], weight, glyphs }
}

function unicodeRecords(text, filename, version) {
  assert(typeof text === 'string' && typeof filename === 'string' && /^\d+\.\d+\.\d+$/.test(version))
  assert(text.startsWith(`# ${filename.replace('.txt', '')}-${version}.txt`), `Unicode version differs: ${filename}`)
  return text.split('\n').map((line) => line.split('#')[0].trim()).filter(Boolean).map((line) => {
    const match = line.match(/^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*([^;]+?)(?:\s*;\s*(\w+))?$/)
    assert(match, `Invalid Unicode record: ${filename}: ${line}`)
    const start = Number.parseInt(match[1], 16)
    const end = Number.parseInt(match[2] ?? match[1], 16)
    assert(start <= end && end <= 0x10ffff, `Invalid Unicode range: ${filename}`)
    return { start, end, name: match[3].trim(), type: match[4] }
  })
}

async function readUnicode(glyphs) {
  assert(Array.isArray(glyphs) && glyphs.length > 0)
  const directory = path.resolve(import.meta.dirname, 'unicode')
  const files = ['SOURCE', 'Blocks.txt', 'DerivedName.txt', 'NameAliases.txt', 'LICENSE.txt']
  const [source, blockText, nameText, aliasText, license] = await Promise.all(files.map((file) => fs.readFile(path.resolve(directory, file), 'utf8')))
  const version = source.match(/^Version: (\d+\.\d+\.\d+)$/m)?.[1]
  assert(version, 'Missing Unicode version in unicode/SOURCE')
  const blocks = unicodeRecords(blockText, 'Blocks.txt', version).filter((block) => glyphs.some((glyph) => glyph.code >= block.start && glyph.code <= block.end))
  const codes = new Set(glyphs.map((glyph) => glyph.code))
  const names = new Map()
  for (const record of unicodeRecords(nameText, 'DerivedName.txt', version)) {
    for (const code of Array.from({ length: record.end - record.start + 1 }, (_, index) => record.start + index)) {
      if (codes.has(code)) {
        assert(!names.has(code), `Repeated Unicode name: ${code}`)
        names.set(code, record.name.replace('*', code.toString(16).toUpperCase().padStart(4, '0')))
      }
    }
  }
  const aliases = unicodeRecords(aliasText, 'NameAliases.txt', version).filter((record) => codes.has(record.start))
  return { version, blocks, names, aliases, license }
}

function glyphMetadata(glyph, unicode) {
  assert(glyph && unicode && unicode.names instanceof Map)
  const block = unicode.blocks.find((entry) => glyph.code >= entry.start && glyph.code <= entry.end)
  const aliases = unicode.aliases.filter((entry) => entry.start === glyph.code)
  const metadata = { ...glyph, bdfName: glyph.name, block: block?.name ?? 'No_Block', aliases: aliases.map((entry) => entry.name), nameType: 'Unicode name' }
  if (unicode.names.has(glyph.code)) {
    return { ...metadata, name: unicode.names.get(glyph.code) }
  }
  const control = aliases.find((entry) => entry.type === 'control')
  if (control) {
    return { ...metadata, name: control.name, nameType: 'Control alias' }
  }
  if (metadata.block.includes('Private Use')) {
    return { ...metadata, nameType: 'Private use' }
  }
  return { ...metadata, nameType: 'No Unicode name' }
}

function escapeHtml(text) {
  assert(typeof text === 'string')
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function pngChunk(type, bytes) {
  assert(typeof type === 'string' && /^[A-Z]{4}$/.test(type) && Buffer.isBuffer(bytes))
  const chunk = Buffer.alloc(bytes.length + 12)
  chunk.writeUInt32BE(bytes.length)
  chunk.write(type, 4, 4, 'ascii')
  bytes.copy(chunk, 8)
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}

function fontStyles(font) {
  assert(font && font.width > 0 && font.height > 0 && font.bitmaps.length > 0)
  const columns = 64
  const width = font.width * columns
  const height = font.height * Math.ceil(font.bitmaps.length / columns)
  const stride = Math.ceil(width / 8) + 1
  const pixels = Buffer.alloc(stride * height, 255)
  for (const row of Array.from({ length: height }, (_, index) => index)) {
    pixels[row * stride] = 0
  }
  for (const [index, rows] of font.bitmaps.entries()) {
    const left = index % columns * font.width
    const top = Math.floor(index / columns) * font.height
    for (const [y, row] of rows.entries()) {
      const bits = Number.parseInt(row, 16).toString(2).padStart(row.length * 4, '0')
      const offset = (top + y) * stride + 1
      for (const [x, bit] of [...bits.slice(0, font.width)].entries()) {
        if (bit === '1') {
          const pixel = left + x
          pixels[offset + Math.floor(pixel / 8)] &= ~(0x80 >> pixel % 8)
        }
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 1
  header[9] = 3
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('PLTE', Buffer.from('000000ffffff', 'hex')),
    pngChunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return `#grid[data-font="${font.id}"] { --cell-width: ${font.width}; --cell-height: ${font.height}; --sheet-columns: ${columns}; --sheet-rows: ${Math.ceil(font.bitmaps.length / columns)}; }
#grid[data-font="${font.id}"] .glyph { background-image: url(data:image/png;base64,${png.toString('base64')}); }`
}

function glyphCard(glyph) {
  assert(glyph && Number.isInteger(glyph.code) && Number.isInteger(glyph.index))
  const code = `U+${glyph.code.toString(16).toUpperCase().padStart(4, '0')}`
  const origin = ['Terminus', 'Terplus'][Number(glyph.added)]
  const badge = ['', ' added'][Number(glyph.added)]
  const search = [code, glyph.name, glyph.bdfName, glyph.block, ...glyph.aliases].join(' ').toUpperCase()
  const title = `${glyph.name} · ${glyph.nameType} · ${glyph.block} · BDF: ${glyph.bdfName}`
  const note = []
  if (glyph.nameType !== 'Unicode name') {
    note.push(`<p class="name">${escapeHtml(glyph.nameType)}</p>`)
  }
  return `<article class="card" data-code="${glyph.code}" data-source="${origin.toLowerCase()}" data-block="${escapeHtml(glyph.block)}" data-search="${
    escapeHtml(search)
  }"><h2>${code}</h2><span class="badge${badge}">${origin}</span><div class="sample"><span class="glyph" role="img" aria-label="${code}, ${escapeHtml(glyph.name)}" style="--column:${
    glyph.index % 64
  };--row:${Math.floor(glyph.index / 64)}"></span></div><div class="description"><p class="name" title="${escapeHtml(title)}">${escapeHtml(glyph.name)}</p>${note.join('')}</div></article>`
}

function initializeCatalog() {
  if (!document.querySelector('#grid')) {
    return
  }
  const font = document.querySelector('#font')
  const source = document.querySelector('#source')
  const range = document.querySelector('#range')
  const search = document.querySelector('#search')
  const zoom = document.querySelector('#zoom')
  const invert = document.querySelector('#invert')
  const grid = document.querySelector('#grid')
  const status = document.querySelector('#status')
  const empty = document.querySelector('#empty')
  const cards = [...grid.querySelectorAll('.card')].map((element) => ({
    element,
    code: Number(element.dataset.code),
    character: String.fromCodePoint(Number(element.dataset.code)),
    source: element.dataset.source,
    block: element.dataset.block,
    search: element.dataset.search,
  }))

  function matches(card, query) {
    if (query.source !== 'all' && card.source !== query.source) {
      return false
    }
    if (query.block !== 'all' && card.block !== query.block) {
      return false
    }
    if (!query.text) {
      return true
    }
    if (query.interval) {
      return card.code >= query.interval[0] && card.code <= query.interval[1]
    }
    if (Number.isInteger(query.code)) {
      return card.code === query.code
    }
    return card.search.includes(query.text) || card.character === query.character
  }

  function updateStatus() {
    const profile = font.selectedOptions[0]
    if (!profile) {
      return
    }
    const summary =
      `${grid.dataset.visible} of ${cards.length} glyphs · ${grid.dataset.terminus} Terminus · ${grid.dataset.terplus} Terplus · ${profile.dataset.width} × ${profile.dataset.height} pixels · ${profile.dataset.weight}`
    if (status.textContent !== summary) {
      status.textContent = summary
    }
  }

  function filter(event) {
    if (!cards.length || event?.isComposing) {
      return
    }
    const text = search.value.trim().toUpperCase()
    const query = {
      text: text.replace(/^0X/, 'U+'),
      source: source.value,
      block: range.value,
      character: search.value.trim(),
      interval: text.match(/^(?:U\+|0X)?([0-9A-F]{4,6})\s*[-–]\s*(?:U\+|0X)?([0-9A-F]{4,6})$/)?.slice(1).map((code) => parseInt(code, 16)),
      code: parseInt(text.match(/^(?:U\+|0X)?([0-9A-F]{4,6})$/)?.[1], 16),
    }
    const counts = { terminus: 0, terplus: 0 }
    for (const card of cards) {
      const visible = matches(card, query)
      if (card.element.hidden === visible) {
        card.element.hidden = !visible
      }
      if (visible) {
        counts[card.source] += 1
      }
    }
    grid.dataset.visible = counts.terminus + counts.terplus
    grid.dataset.terminus = counts.terminus
    grid.dataset.terplus = counts.terplus
    empty.hidden = counts.terminus + counts.terplus > 0
    updateStatus()
  }

  function updateDisplay() {
    if (!font.selectedOptions.length) {
      return
    }
    if (grid.dataset.font !== font.value) {
      grid.dataset.font = font.value
    }
    if (grid.dataset.colors !== invert.value) {
      grid.dataset.colors = invert.value
    }
    if (grid.dataset.zoom !== zoom.value) {
      grid.dataset.zoom = zoom.value
    }
    updateStatus()
  }

  for (const control of [source, range]) {
    control.addEventListener('change', filter)
  }
  for (const control of [font, zoom, invert]) {
    control.addEventListener('change', updateDisplay)
  }
  search.addEventListener('input', filter)
  search.addEventListener('compositionend', filter)
  document.querySelector('#reset').addEventListener('click', () => {
    source.value = 'all'
    range.value = 'all'
    search.value = ''
    filter()
  })
  updateDisplay()
  if (source.value !== 'all' || range.value !== 'all' || search.value.trim()) {
    filter()
  }
}

function catalogPage(data, license, unicodeLicense) {
  assert(data.fonts.length === 18 && typeof license === 'string' && typeof unicodeLicense === 'string')
  const images = data.fonts.map(fontStyles).join('\n')
  const cards = data.glyphs.map(glyphCard).join('\n')
  const added = data.glyphs.filter((glyph) => glyph.added).length
  const original = data.glyphs.length - added
  const defaultFont = data.fonts.find((font) => font.id === 'terplus-u18n')
  assert(defaultFont, 'Missing default font')
  const summary = `${data.glyphs.length} of ${data.glyphs.length} glyphs · ${original} Terminus · ${added} Terplus · ${defaultFont.width} × ${defaultFont.height} pixels · ${defaultFont.weight}`
  const fontOptions = data.fonts.map((font) =>
    `<option value="${font.id}" data-width="${font.width}" data-height="${font.height}" data-weight="${font.weight}" ${
      ['', 'selected'][Number(font.id === defaultFont.id)]
    }>${font.height} px · ${font.weight} · ${font.width} × ${font.height}</option>`
  ).join('')
  const blockOptions = data.blocks.map((block) =>
    `<option value="${escapeHtml(block.name)}">${escapeHtml(block.name)} (U+${block.start.toString(16).toUpperCase().padStart(4, '0')}–U+${
      block.end.toString(16).toUpperCase().padStart(4, '0')
    })</option>`
  )
  if (data.glyphs.some((glyph) => glyph.block === 'No_Block')) {
    blockOptions.push('<option value="No_Block">No Unicode block</option>')
  }
  const notice = escapeHtml(license)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Terplus</title>
<style>
:root { color-scheme: light; font-family: system-ui, sans-serif; color: #000000; background: #ffffff; scrollbar-gutter: stable; }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 32px; max-width: 1800px; }
h1 { margin: 0; font-size: 30px; letter-spacing: -.03em; }
header p { max-width: 78ch; line-height: 1.6; }
.controls { display: flex; flex-wrap: wrap; align-items: end; gap: 16px; padding: 20px 0; border-block: 1px solid #000; }
.display { border-top: 0; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; font-weight: 600; max-width: 100%; }
select, input, button { font: inherit; color: #000; background: #fff; border: 1px solid #000; border-radius: 4px; padding: 9px; height: 40px; }
select { appearance: none; padding-inline: 12px 36px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='m1 1 5 5 5-5' fill='none' stroke='%23000' stroke-width='1.5'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; background-size: 12px 8px; }
@media (forced-colors: active) { select { appearance: auto; background-image: none; } }
#range { width: 360px; max-width: 100%; }
.search { flex: 1 1 280px; }
button { cursor: pointer; }
:focus-visible { outline: 3px solid #000; outline-offset: 3px; }
#status { margin: 20px 0; font-size: 14px; }
#grid { --zoom: 1; --glyph-width: calc(var(--cell-width) * var(--zoom) * 1px); --glyph-height: calc(var(--cell-height) * var(--zoom) * 1px); --glyph-background: #000000; --glyph-filter: invert(1); --card-width: max(156px, calc(var(--glyph-width) + 34px)); display: grid; grid-template-columns: repeat(auto-fill, var(--card-width)); justify-content: space-between; gap: 12px; }
#grid[data-colors="0"] { --glyph-background: #ffffff; --glyph-filter: invert(0); }
#grid[data-colors="2"] { --glyph-filter: url(#xterm-green); }
#grid[data-zoom="2"] { --zoom: 2; }
#grid[data-zoom="4"] { --zoom: 4; }
#grid[data-zoom="6"] { --zoom: 6; }
#grid[data-zoom="8"] { --zoom: 8; }
${images}
.card { display: grid; grid-template-rows: 18px 20px calc(var(--glyph-height) + 24px) 90px; gap: 10px; width: var(--card-width); height: calc(var(--glyph-height) + 212px); min-width: 0; border: 1px solid #aaa; border-radius: 5px; padding: 14px; content-visibility: auto; }
.card[hidden] { display: none; }
.card h2 { margin: 0; font: 600 14px ui-monospace, monospace; }
.badge { justify-self: start; align-self: start; display: flex; align-items: center; justify-content: center; width: 66px; height: 20px; border: 1px solid #000; border-radius: 3px; font-size: 12px; font-weight: 600; line-height: 1; }
.badge.added { border-style: dashed; border-width: 2px; }
.sample { min-height: calc(var(--glyph-height) + 24px); display: flex; align-items: center; justify-content: center; background: var(--glyph-background); border: 1px solid #aaa; padding: 11px 0; }
.glyph { display: block; width: var(--glyph-width); height: var(--glyph-height); background-size: calc(var(--sheet-columns) * var(--glyph-width)) calc(var(--sheet-rows) * var(--glyph-height)); background-position: calc(var(--column) * var(--glyph-width) * -1) calc(var(--row) * var(--glyph-height) * -1); background-repeat: no-repeat; image-rendering: pixelated; image-rendering: crisp-edges; filter: var(--glyph-filter); }
.description { min-height: 0; overflow: clip; }
.name { margin: 0; font: 12px/15px ui-monospace, monospace; overflow-wrap: anywhere; }
.name + .name { margin-top: 6px; }
footer { margin-top: 32px; border-top: 1px solid #000; padding-top: 16px; font-size: 13px; }
footer pre { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 600px) { body { padding: 16px; } .controls { gap: 12px; } }
</style>
</head>
<body>
<svg width="0" height="0" aria-hidden="true" style="position:absolute"><defs><filter id="xterm-green" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0  0 -0.8039215686 0 0 0.8039215686  0 0 0 0 0  0 0 0 1 0"/></filter></defs></svg>
<header>
<h1>Terplus</h1>
<p>Terplus is a bitmap font based on Terminus Font.</p>
<p><a href="https://github.com/kotarac/terplus">GitHub repository</a> · <a href="https://github.com/kotarac/terplus/releases">Releases</a></p>
<p>This catalog shows glyphs from all 18 BDF files. Select a size and weight to see the saved bitmaps. Terminus labels mark original glyphs. Terplus labels mark added glyphs.</p>
</header>
<div class="controls" role="region" aria-label="Filters">
<label>Font<select id="font">${fontOptions}</select></label>
<label>Source<select id="source"><option value="all">All glyphs</option><option value="terminus">Terminus original</option><option value="terplus">Terplus additions</option></select></label>
<label>Unicode block<select id="range"><option value="all">All blocks</option>${blockOptions.join('')}</select></label>
<label class="search">Search<input id="search" type="search" spellcheck="false" autocomplete="off" placeholder="Character, name, U+0041, or 0041–005A" aria-describedby="search-help"></label>
<button id="reset" type="button">Clear filters</button>
</div>
<section class="controls display" aria-label="Display controls">
<label>Zoom<select id="zoom"><option value="1">1x</option><option value="2" selected>2x</option><option value="4">4x</option><option value="6">6x</option><option value="8">8x</option></select></label>
<label>Glyph colors<select id="invert"><option value="1" selected>White glyphs on black</option><option value="0">Black glyphs on white</option><option value="2">Green glyphs on black</option></select></label>
</section>
<p id="search-help">Search by Unicode name, alias, block, or BDF name. Code point ranges use hexadecimal numbers. Private-use glyphs keep their BDF names.</p>
<p id="status" role="status" aria-live="polite">${summary}</p>
<main id="grid" aria-label="Glyphs" data-font="${defaultFont.id}" data-zoom="2" data-colors="1" data-visible="${data.glyphs.length}" data-terminus="${original}" data-terplus="${added}">${cards}</main>
<p id="empty" hidden>No glyphs match these filters.</p>
<noscript><p>Enable JavaScript to use the filters and display controls.</p></noscript>
<footer>This page contains all bitmap data. It does not need a network connection or other files.
<details><summary>Font license</summary><pre>${notice}</pre></details>
<details><summary>Unicode ${data.unicodeVersion} data license</summary><pre>${escapeHtml(unicodeLicense)}</pre></details>
</footer>
<script>(${initializeCatalog.toString()})()</script>
</body>
</html>
`
}

assert(typeof import.meta.dirname === 'string', 'Node.js must support import.meta.dirname')
assert(process.argv.length === 2, 'Usage: node catalog.js')
const filenames = (await fs.readdir(import.meta.dirname)).filter((name) => /^terplus-u\d+[nb]\.bdf$/.test(name))
assert(filenames.length === 18, 'Expected 18 BDF files')
const fonts = await Promise.all(filenames.map(readFont))
fonts.sort((left, right) => left.height - right.height || right.weight.localeCompare(left.weight))
const glyphs = fonts[0].glyphs.map(({ code, name, added }, index) => ({ code, name, added, index }))
for (const font of fonts) {
  assert.deepEqual(font.glyphs.map(({ code, name, added }, index) => ({ code, name, added, index })), glyphs, `Glyph metadata differs: ${font.id}`)
}
const unicode = await readUnicode(glyphs)
const data = {
  unicodeVersion: unicode.version,
  blocks: unicode.blocks,
  glyphs: glyphs.map((glyph) => glyphMetadata(glyph, unicode)),
  fonts: fonts.map(({ glyphs, ...font }) => ({ ...font, bitmaps: glyphs.map((glyph) => glyph.rows) })),
}
const license = await fs.readFile(path.resolve(import.meta.dirname, 'LICENSE'), 'utf8')
const output = path.resolve(import.meta.dirname, 'target', 'catalog.html')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, catalogPage(data, license, unicode.license))
console.log(`Built ${output}: ${glyphs.length} glyphs in ${fonts.length} fonts.`)
