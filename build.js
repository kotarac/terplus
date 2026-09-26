// Copyright (C) 2026 Stipe Kotarac
// SPDX-License-Identifier: OFL-1.1

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

function binaryNumbers(type, values, order = 'BE') {
  assert.match(type, /^[ui](8|16|32)$/)
  assert(Array.isArray(values))
  assert(order === 'BE' || order === 'LE')
  const width = Number(type.slice(1)) / 8
  const signed = type[0] === 'i'
  const limit = 2 ** (width * 8 - Number(signed))
  const result = Buffer.alloc(width * values.length)
  const method = { u: `writeUInt${order}`, i: `writeInt${order}` }[type[0]]
  for (const [index, value] of values.entries()) {
    assert(Number.isInteger(value) && (value >= 0 || (signed && value >= -limit)) && value < limit, `Invalid ${type}: ${value}`)
    result[method](value, index * width, width)
  }
  return result
}

function padded(bytes) {
  assert(Buffer.isBuffer(bytes))
  return Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)])
}

function decimalFields(text, count) {
  assert.equal(typeof text, 'string')
  assert(Number.isInteger(count) && count > 0)
  const fields = text.trim().split(/\s+/)
  assert.equal(fields.length, count)
  assert(fields.every((field) => /^-?\d+$/.test(field)))
  const values = fields.map(Number)
  assert(values.every(Number.isSafeInteger))
  return values
}

function mappingNumber(text) {
  assert(typeof text === 'string' && /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(text), `Invalid mapping number: ${text}`)
  const value = parseMappingNumber(text)
  assert(Number.isSafeInteger(value) && value <= 0x10ffff, `Mapping number out of range: ${text}`)
  return value
}

function parseMappingNumber(text) {
  assert(typeof text === 'string' && text.length > 0)
  if (/^0[xX]/.test(text)) {
    return Number.parseInt(text, 16)
  }
  if (text.startsWith('0')) {
    return Number.parseInt(text, 8)
  }
  return Number.parseInt(text, 10)
}

function unicodeValue(text) {
  assert(typeof text === 'string' && /^U\+[0-9a-fA-F]{4,6}$/.test(text), `Invalid Unicode assignment: ${text}`)
  const value = Number.parseInt(text.slice(2), 16)
  assert(value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) && value !== 0xfffe && value !== 0xffff)
  return value
}

function propertyValue(text) {
  assert(typeof text === 'string' && text.length > 0)
  if (text[0] === '"') {
    return text.slice(1, -1).replaceAll('""', '"')
  }
  return Number(text)
}

function parseProperties(header) {
  assert.equal(typeof header, 'string')
  const section = header.match(/^STARTPROPERTIES (\d+)\n([\s\S]*?)^ENDPROPERTIES\n/m)
  assert(section, 'Missing BDF properties')
  const properties = new Map()
  for (const line of section[2].trimEnd().split('\n')) {
    const entry = line.match(/^([A-Z_][A-Z_0-9]*) ("(?:[^"]|"")*"|-?\d+)$/)
    assert(entry && !properties.has(entry[1]), `Invalid or repeated BDF property: ${line.slice(0, 80)}`)
    properties.set(entry[1], propertyValue(entry[2]))
  }
  assert.equal(properties.size, Number(section[1]), 'Incorrect STARTPROPERTIES count')
  assert.equal(properties.get('FAMILY_NAME'), 'Terplus')
  assert(['Medium', 'Bold'].includes(properties.get('WEIGHT_NAME')))
  assert.equal(properties.get('SLANT'), 'R')
  assert(typeof properties.get('FONT_VERSION') === 'string' && /^\d+\.\d+\.\d+$/.test(properties.get('FONT_VERSION')))
  assert(typeof properties.get('COPYRIGHT') === 'string' && properties.get('COPYRIGHT').length > 0)
  assert(typeof properties.get('NOTICE') === 'string' && properties.get('NOTICE').includes('SIL Open Font License'))
  return properties
}

function parseGlyph(block, cell, previousCode) {
  assert.equal(typeof block, 'string')
  assert(Array.isArray(cell) && cell.length === 4)
  assert(Number.isInteger(previousCode))
  const match = block.match(/^STARTCHAR (\S+)\nENCODING (\d+)\nSWIDTH ([^\n]+)\nDWIDTH ([^\n]+)\nBBX ([^\n]+)\nBITMAP\n([\s\S]*?)ENDCHAR\n$/)
  assert(match, 'Invalid BDF glyph block')
  const code = Number(match[2])
  assert(Number.isInteger(code) && code > previousCode && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff), `Invalid or unordered encoding: ${match[2]}`)
  const box = decimalFields(match[5], 4)
  const advance = decimalFields(match[4], 2)
  const scalable = decimalFields(match[3], 2)
  assert.deepEqual(box, cell, `Glyph U+${code.toString(16)} must fill the font cell`)
  assert.deepEqual(advance, [cell[0], 0])
  assert(scalable[0] > 0 && scalable[1] === 0)
  const rows = match[6].trimEnd().split('\n')
  const stride = Math.ceil(cell[0] / 8)
  assert.equal(rows.length, cell[1], `Incorrect row count: ${match[1]}`)
  assert(rows.every((row) => row.length === stride * 2 && /^[0-9A-F]+$/.test(row)), `Invalid bitmap: ${match[1]}`)
  const bitmap = Buffer.from(rows.join(''), 'hex')
  const paddingMask = (1 << (stride * 8 - cell[0])) - 1
  for (const row of rows.keys()) {
    assert.equal(bitmap[(row + 1) * stride - 1] & paddingMask, 0, `Nonzero bitmap padding: ${match[1]}`)
  }
  return { code, name: match[1], bitmap, scalableWidth: scalable[0] }
}

function parseMapping(source) {
  assert.equal(typeof source, 'string')
  const mapping = Array.from({ length: 512 }, () => [])
  for (const line of source.split(/\r?\n/)) {
    const content = line.split('#', 1)[0].trim()
    if (!content) {
      continue
    }
    const fields = content.replace(/,\s*/g, ',').split(/\s+/)
    const index = mappingNumber(fields.shift())
    assert(index < mapping.length, `Invalid console slot: ${index}`)
    for (const field of fields) {
      mapping[index].push(field.split(',').map(unicodeValue))
    }
  }
  assert(mapping.every((aliases) => aliases[0]?.length === 1), 'Each of the 512 console slots needs a BDF encoding as its first assignment')
  return mapping.map((aliases) => [...aliases.filter((sequence) => sequence.length === 1), ...aliases.filter((sequence) => sequence.length > 1)])
}

function consoleSlots(mapping, glyphIndex) {
  assert(Array.isArray(mapping) && mapping.length === 512)
  assert(glyphIndex instanceof Map && glyphIndex.size > 0)
  return mapping.map((aliases) => {
    assert(aliases[0]?.length === 1)
    const glyph = glyphIndex.get(aliases[0][0])
    assert(glyph, `Console slot uses a missing glyph: ${aliases[0][0]}`)
    return { glyph, aliases }
  })
}

async function readFont(file) {
  assert(typeof file === 'string' && path.isAbsolute(file))
  const profile = path.basename(file).match(/^terplus-u(12|14|16|18|20|22|24|28|32)([nb])\.bdf$/)
  assert(profile, `Invalid font filename: ${file}`)
  const source = (await fs.readFile(file, 'utf8')).replaceAll('\r\n', '\n')
  assert(source.startsWith('STARTFONT 2.1\n') && source.endsWith('ENDFONT\n'), `Incomplete BDF: ${file}`)
  const start = source.indexOf('STARTCHAR ')
  assert(start > 0)
  const header = source.slice(0, start)
  const properties = parseProperties(header)
  assert.equal(properties.get('WEIGHT_NAME'), { n: 'Medium', b: 'Bold' }[profile[2]], `Weight differs from filename: ${file}`)
  assert.equal(properties.get('PIXEL_SIZE'), Number(profile[1]), `Pixel size differs from filename: ${file}`)
  const bounds = header.match(/^FONTBOUNDINGBOX (.+)$/m)
  const declared = header.match(/^CHARS (\d+)$/m)
  const fontName = header.match(/^FONT (.+)$/m)
  assert(bounds && declared && fontName)
  const xlfdProperties = [
    'FOUNDRY',
    'FAMILY_NAME',
    'WEIGHT_NAME',
    'SLANT',
    'SETWIDTH_NAME',
    'ADD_STYLE_NAME',
    'PIXEL_SIZE',
    'POINT_SIZE',
    'RESOLUTION_X',
    'RESOLUTION_Y',
    'SPACING',
    'AVERAGE_WIDTH',
    'CHARSET_REGISTRY',
    'CHARSET_ENCODING',
  ]
  assert(xlfdProperties.every((name) => properties.has(name)), `Missing XLFD property: ${file}`)
  assert.equal(fontName[1], '-' + xlfdProperties.map((name) => properties.get(name)).join('-'), `XLFD differs from BDF properties: ${file}`)
  const cell = decimalFields(bounds[1], 4)
  const [width, height, left, bottom] = cell
  const ascent = properties.get('FONT_ASCENT')
  const descent = properties.get('FONT_DESCENT')
  assert(width > 0 && width <= 32 && height === Number(profile[1]) && left === 0)
  assert(Number.isInteger(ascent) && Number.isInteger(descent) && ascent > 0 && descent >= 0)
  assert.equal(ascent + descent, height)
  assert.equal(bottom, -descent)
  const body = source.slice(start, -'ENDFONT\n'.length)
  const sections = body.split('COMMENT End of Terminus glyphs. Terplus additions follow.\n')
  assert.equal(sections.length, 2, `Expected one glyph cutoff comment: ${file}`)
  const glyphs = []
  for (const section of sections) {
    const blocks = section.match(/^STARTCHAR [\s\S]*?^ENDCHAR\n/gm)
    assert(blocks && blocks.join('') === section, `Invalid glyph section: ${file}`)
    const sectionGlyphs = []
    for (const block of blocks) {
      sectionGlyphs.push(parseGlyph(block, cell, sectionGlyphs.at(-1)?.code ?? -1))
    }
    glyphs.push(...sectionGlyphs)
  }
  assert.equal(glyphs.length, Number(declared[1]), `Incorrect CHARS count: ${file}`)
  assert(glyphs.length < 65536)
  glyphs.sort((first, second) => first.code - second.code)
  const glyphIndex = new Map(glyphs.map((glyph) => [glyph.code, glyph]))
  assert.equal(glyphIndex.size, glyphs.length, `Repeated glyph encoding: ${file}`)
  assert(glyphIndex.has(properties.get('DEFAULT_CHAR')))
  assert.equal(glyphs[0].code, 0, 'The first glyph must provide .notdef')
  return { profile: profile[1] + profile[2], name: fontName[1], width, height, ascent, descent, properties, glyphs, glyphIndex }
}

function makePsf(font, slots) {
  assert(font?.width > 0 && Array.isArray(slots) && slots.length === 512)
  const bitmapSize = Math.ceil(font.width / 8) * font.height
  const header = binaryNumbers('u32', [0x864ab572, 0, 32, 1, slots.length, bitmapSize, font.height, font.width], 'LE')
  const separator = Buffer.from([255])
  const sequenceStart = Buffer.from([254])
  const unicode = []
  for (const slot of slots) {
    assert.equal(slot.glyph.bitmap.length, bitmapSize)
    for (const sequence of slot.aliases) {
      if (sequence.length > 1) {
        unicode.push(sequenceStart)
      }
      unicode.push(Buffer.from(String.fromCodePoint(...sequence)))
    }
    unicode.push(separator)
  }
  return Buffer.concat([header, ...slots.map((slot) => slot.glyph.bitmap), ...unicode])
}

function byteLength(buffers) {
  assert(Array.isArray(buffers) && buffers.every(Buffer.isBuffer))
  return buffers.reduce((length, buffer) => length + buffer.length, 0)
}

function bufferOffsets(buffers, start = 0) {
  assert(Array.isArray(buffers) && buffers.every(Buffer.isBuffer))
  assert(Number.isSafeInteger(start) && start >= 0)
  const offsets = [start]
  for (const buffer of buffers) {
    offsets.push(offsets.at(-1) + buffer.length)
  }
  return offsets
}

function pcfProperties(font) {
  assert(font?.properties instanceof Map)
  assert(typeof font.name === 'string' && font.name.length > 0)
  const properties = new Map(font.properties)
  properties.set('FONT', font.name)
  const strings = []
  const records = [...properties].map(([name, value]) => {
    const position = byteLength(strings)
    const key = Buffer.from(name + '\0', 'latin1')
    strings.push(key)
    if (typeof value !== 'string') {
      return Buffer.concat([binaryNumbers('u32', [position]), binaryNumbers('u8', [0]), binaryNumbers('i32', [value])])
    }
    strings.push(Buffer.from(value + '\0', 'latin1'))
    return Buffer.concat([binaryNumbers('u32', [position]), binaryNumbers('u8', [1]), binaryNumbers('u32', [position + key.length])])
  })
  return Buffer.concat([binaryNumbers('u32', [4], 'LE'), binaryNumbers('u32', [records.length]), padded(Buffer.concat(records)), binaryNumbers('u32', [byteLength(strings)]), ...strings])
}

function pcfEncoding(font, glyphs) {
  assert(font?.properties instanceof Map && Array.isArray(glyphs) && glyphs.length > 0)
  const last = Math.max(...glyphs.map((glyph) => glyph.code))
  assert(last <= 65535)
  const high = last >> 8
  const indices = new Array((high + 1) * 256).fill(65535)
  for (const [index, glyph] of glyphs.entries()) {
    assert.equal(indices[glyph.code], 65535, `Repeated PCF encoding: ${glyph.code}`)
    indices[glyph.code] = index
  }
  return Buffer.concat([binaryNumbers('u32', [4], 'LE'), binaryNumbers('u16', [0, 255, 0, high, font.properties.get('DEFAULT_CHAR'), ...indices])])
}

function pcfBitmap(font, glyphs) {
  assert(font?.width > 0 && Array.isArray(glyphs) && glyphs.length > 0)
  const stride = Math.ceil(font.width / 8)
  const size = stride * font.height
  const offsets = glyphs.map((_, index) => index * size)
  const paddedSizes = [1, 2, 4, 8].map((alignment) => Math.ceil(stride / alignment) * alignment * font.height * glyphs.length)
  return Buffer.concat([binaryNumbers('u32', [12], 'LE'), binaryNumbers('u32', [glyphs.length, ...offsets, ...paddedSizes]), ...glyphs.map((glyph) => glyph.bitmap)])
}

function pcfNames(glyphs) {
  assert(Array.isArray(glyphs) && glyphs.length > 0)
  const strings = glyphs.map((glyph) => Buffer.from(glyph.name + '\0', 'ascii'))
  const offsets = bufferOffsets(strings)
  return Buffer.concat([binaryNumbers('u32', [4], 'LE'), binaryNumbers('u32', [glyphs.length, ...offsets]), ...strings])
}

function glyphInkMetrics(font, glyph) {
  assert(font?.width > 0 && font.height > 0 && Buffer.isBuffer(glyph?.bitmap))
  const stride = Math.ceil(font.width / 8)
  assert.equal(glyph.bitmap.length, stride * font.height)
  const rows = Array.from({ length: font.height }, (_, row) => {
    const columns = Array.from({ length: font.width }, (_, column) => column)
      .filter((column) => glyph.bitmap[row * stride + Math.floor(column / 8)] & (0x80 >> (column % 8)))
    if (columns.length === 0) {
      return null
    }
    return { row, left: columns[0], right: columns.at(-1) + 1 }
  }).filter(Boolean)
  if (rows.length === 0) {
    return [0, 0, font.width, 0, 0, 0]
  }
  return [Math.min(...rows.map((row) => row.left)), Math.max(...rows.map((row) => row.right)), font.width, font.ascent - rows[0].row, rows.at(-1).row + 1 - font.ascent, 0]
}

function makePcf(font) {
  assert(font?.glyphs?.length > 0)
  const glyphs = font.glyphs.filter((glyph) => glyph.code <= 65535)
  const metrics = [0, font.width, font.width, font.ascent, font.descent]
  const compressed = binaryNumbers('u8', metrics.map((value) => value + 128))
  const bounds = binaryNumbers('i16', [...metrics, 0])
  const inkMetrics = glyphs.map((glyph) => glyphInkMetrics(font, glyph))
  const inkMinimum = Array.from({ length: 6 }, (_, index) => Math.min(...inkMetrics.map((metric) => metric[index])))
  const inkMaximum = Array.from({ length: 6 }, (_, index) => Math.max(...inkMetrics.map((metric) => metric[index])))
  const accelerator = Buffer.concat([
    binaryNumbers('u32', [0x104], 'LE'),
    Buffer.from([1, 1, 1, 1, 1, 1, 0, 0]),
    binaryNumbers('i32', [font.ascent, font.descent, 0]),
    bounds,
    bounds,
    binaryNumbers('i16', [...inkMinimum, ...inkMaximum]),
  ])
  const tables = [
    [1, 4, pcfProperties(font)],
    [2, 0x104, accelerator],
    [4, 0x104, Buffer.concat([binaryNumbers('u32', [0x104], 'LE'), binaryNumbers('u16', [glyphs.length]), ...glyphs.map(() => compressed)])],
    [8, 12, pcfBitmap(font, glyphs)],
    [
      16,
      0x104,
      Buffer.concat([binaryNumbers('u32', [0x104], 'LE'), binaryNumbers('u16', [glyphs.length]), ...inkMetrics.map((metric) => binaryNumbers('u8', metric.slice(0, 5).map((value) => value + 128)))]),
    ],
    [32, 4, pcfEncoding(font, glyphs)],
    [64, 4, Buffer.concat([binaryNumbers('u32', [4], 'LE'), binaryNumbers('u32', [glyphs.length, ...glyphs.map((glyph) => glyph.scalableWidth)])])],
    [128, 4, pcfNames(glyphs)],
    [256, 0x104, accelerator],
  ]
  const content = tables.map(([, , table]) => padded(table))
  const offsets = bufferOffsets(content, 8 + 16 * tables.length)
  const directory = tables.map(([type, format], index) => binaryNumbers('u32', [type, format, content[index].length, offsets[index]], 'LE'))
  return Buffer.concat([binaryNumbers('u32', [0x70636601, tables.length], 'LE'), ...directory, ...content])
}

function designUnits(font, pixels) {
  assert(font?.height > 0 && Number.isFinite(pixels))
  return Math.round(pixels * 1024 / font.height)
}

function otbBitmaps(font) {
  assert(font?.glyphs?.length > 0)
  const imageSize = 5 + Math.ceil(font.width / 8) * font.height
  const smallMetrics = Buffer.concat([binaryNumbers('u8', [font.height, font.width]), binaryNumbers('i8', [0, font.ascent]), binaryNumbers('u8', [font.width])])
  const data = Buffer.concat([binaryNumbers('u32', [0x00020000]), ...font.glyphs.map((glyph) => Buffer.concat([smallMetrics, glyph.bitmap]))])
  const offsets = binaryNumbers('u32', Array.from({ length: font.glyphs.length + 1 }, (_, index) => index * imageSize))
  const indexArray = Buffer.concat([binaryNumbers('u16', [0, font.glyphs.length - 1]), binaryNumbers('u32', [8])])
  const indexSubtable = Buffer.concat([binaryNumbers('u16', [1, 1]), binaryNumbers('u32', [4]), offsets])
  const lineMetrics = binaryNumbers('i8', [font.ascent, -font.descent, font.width, 1, 0, 0, 0, 0, font.ascent, -font.descent, 0, 0])
  const sizeTable = Buffer.concat([
    binaryNumbers('u32', [56, indexArray.length + indexSubtable.length, 1, 0]),
    lineMetrics,
    Buffer.alloc(12),
    binaryNumbers('u16', [0, font.glyphs.length - 1]),
    binaryNumbers('u8', [font.height, font.height, 1, 1]),
  ])
  assert.equal(sizeTable.length, 48)
  return new Map([['EBDT', data], ['EBLC', Buffer.concat([binaryNumbers('u32', [0x00020000, 1]), sizeTable, indexArray, indexSubtable])]])
}

function otbCharacterMap(font) {
  assert(font?.glyphs?.length > 0)
  const groups = font.glyphs.map((glyph, index) => binaryNumbers('u32', [glyph.code, glyph.code, index]))
  const subtable = Buffer.concat([binaryNumbers('u16', [12, 0]), binaryNumbers('u32', [16 + groups.length * 12, 0, groups.length]), ...groups])
  return Buffer.concat([binaryNumbers('u16', [0, 2, 0, 4]), binaryNumbers('u32', [20]), binaryNumbers('u16', [3, 10]), binaryNumbers('u32', [20]), subtable])
}

function fontStyle(font) {
  assert(font?.properties instanceof Map)
  assert(['Medium', 'Bold'].includes(font.properties.get('WEIGHT_NAME')))
  if (font.properties.get('WEIGHT_NAME') === 'Bold') {
    return { name: 'Bold', weight: 700, selection: 0x20, macStyle: 1 }
  }
  return { name: 'Regular', weight: 400, selection: 0x40, macStyle: 0 }
}

function otbNames(font) {
  assert(font?.properties instanceof Map)
  const family = font.properties.get('FAMILY_NAME')
  const version = font.properties.get('FONT_VERSION')
  assert(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version))
  const style = fontStyle(font).name
  const values = new Map([
    [0, font.properties.get('COPYRIGHT')],
    [1, family],
    [2, style],
    [3, `${family};${version};${font.profile}`],
    [4, `${family} ${style}`],
    [5, `Version ${version}`],
    [6, `${family}-${style}`],
    [13, font.properties.get('NOTICE')],
    [14, 'https://openfontlicense.org'],
  ])
  const strings = []
  const records = []
  for (const [id, value] of values) {
    assert.equal(typeof value, 'string')
    const text = Buffer.from(value, 'utf16le').swap16()
    records.push(binaryNumbers('u16', [3, 1, 0x0409, id, text.length, byteLength(strings)]))
    strings.push(text)
  }
  assert(byteLength(strings) <= 65535)
  return Buffer.concat([binaryNumbers('u16', [0, values.size, 6 + values.size * 12]), ...records, ...strings])
}

function otbHeaders(font) {
  assert(font?.glyphs?.length > 0)
  const ascent = designUnits(font, font.ascent)
  const descent = designUnits(font, font.descent)
  const advance = designUnits(font, font.width)
  const style = fontStyle(font)
  const version = font.properties.get('FONT_VERSION').split('.').map(Number)
  assert(version[0] <= 32767 && version[1] < 100 && version[2] < 100)
  const revision = Math.round((version[0] + version[1] / 100 + version[2] / 10000) * 65536)
  const head = Buffer.concat([
    binaryNumbers('u32', [0x00010000, revision, 0, 0x5f0f3cf5]),
    binaryNumbers('u16', [3, 1024]),
    Buffer.alloc(16),
    binaryNumbers('i16', [0, -descent, advance, ascent]),
    binaryNumbers('u16', [style.macStyle, font.height]),
    binaryNumbers('i16', [2, 0, 0]),
  ])
  const hhea = Buffer.concat([
    binaryNumbers('u32', [0x00010000]),
    binaryNumbers('i16', [ascent, -descent, 0, advance, 0, 0, advance, 1, 0, 0, 0, 0, 0, 0, 0]),
    binaryNumbers('u16', [font.glyphs.length]),
  ])
  const maxp = Buffer.concat([binaryNumbers('u32', [0x00010000]), binaryNumbers('u16', [font.glyphs.length, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0])])
  const post = Buffer.concat([binaryNumbers('u32', [0x00030000, 0]), binaryNumbers('i16', [-descent, designUnits(font, 1)]), binaryNumbers('u32', [1, 0, 0, 0, 0])])
  assert.equal(head.length, 54)
  assert.equal(hhea.length, 36)
  assert.equal(maxp.length, 32)
  assert.equal(post.length, 32)
  return new Map([['head', head], ['hhea', hhea], ['maxp', maxp], ['post', post]])
}

function otbOs2(font) {
  assert(font?.glyphs?.length > 0)
  const style = fontStyle(font)
  const ascent = designUnits(font, font.ascent)
  const descent = designUnits(font, font.descent)
  const advance = designUnits(font, font.width)
  const table = Buffer.alloc(96)
  table.writeUInt16BE(4, 0)
  table.writeInt16BE(advance, 2)
  table.writeUInt16BE(style.weight, 4)
  table.writeUInt16BE(5, 6)
  table.writeInt16BE(512, 10)
  table.writeInt16BE(512, 12)
  table.writeInt16BE(256, 16)
  table.writeInt16BE(512, 18)
  table.writeInt16BE(512, 20)
  table.writeInt16BE(256, 24)
  table.writeInt16BE(designUnits(font, 1), 26)
  table.writeInt16BE(Math.round(ascent / 3), 28)
  table.write('Terp', 58, 'ascii')
  table.writeUInt16BE(style.selection, 62)
  table.writeUInt16BE(font.glyphs[0].code, 64)
  table.writeUInt16BE(Math.min(65535, font.glyphs.at(-1).code), 66)
  table.writeInt16BE(ascent, 68)
  table.writeInt16BE(-descent, 70)
  table.writeUInt16BE(ascent, 74)
  table.writeUInt16BE(descent, 76)
  table.writeUInt16BE(font.properties.get('DEFAULT_CHAR'), 90)
  table.writeUInt16BE(32, 92)
  table.writeUInt16BE(1, 94)
  if (font.glyphs.some((glyph) => glyph.code > 65535)) {
    table.writeUInt32BE(1 << 25, 46)
  }
  return table
}

function checksum(bytes) {
  assert(Buffer.isBuffer(bytes))
  const data = padded(bytes)
  const words = Array.from({ length: data.length / 4 }, (_, index) => data.readUInt32BE(index * 4))
  return words.reduce((sum, word) => (sum + word) >>> 0, 0)
}

function makeOtb(font) {
  assert(font?.glyphs?.length > 0)
  const advance = designUnits(font, font.width)
  const tables = new Map([...otbBitmaps(font), ...otbHeaders(font)])
  tables.set('OS/2', otbOs2(font))
  tables.set('cmap', otbCharacterMap(font))
  tables.set('name', otbNames(font))
  tables.set('glyf', Buffer.alloc(0))
  tables.set('loca', Buffer.alloc((font.glyphs.length + 1) * 2))
  tables.set('hmtx', binaryNumbers('u16', font.glyphs.flatMap(() => [advance, 0])))
  const power = Math.floor(Math.log2(tables.size))
  const header = Buffer.concat([binaryNumbers('u32', [0x00010000]), binaryNumbers('u16', [tables.size, 16 * 2 ** power, power, 16 * (tables.size - 2 ** power)])])
  const tags = [...tables.keys()].sort()
  const content = tags.map((tag) => padded(tables.get(tag)))
  const offsets = bufferOffsets(content, header.length + tables.size * 16)
  const records = tags.map((tag, index) => {
    const bytes = tables.get(tag)
    return Buffer.concat([Buffer.from(tag, 'ascii'), binaryNumbers('u32', [checksum(bytes), offsets[index], bytes.length])])
  })
  const headOffset = offsets[tags.indexOf('head')]
  assert(headOffset > 0)
  const result = Buffer.concat([header, ...records, ...content])
  result.writeUInt32BE((0xb1b0afba - checksum(result)) >>> 0, headOffset + 8)
  assert.equal(checksum(result), 0xb1b0afba)
  return result
}

async function readConsoleMapping(root, target) {
  assert(typeof root === 'string' && path.isAbsolute(root))
  assert(['all', 'psf', 'pcf', 'otb'].includes(target))
  if (target !== 'all' && target !== 'psf') {
    return null
  }
  return parseMapping(await fs.readFile(path.resolve(root, 'terplus.uni'), 'utf8'))
}

const root = import.meta.dirname
assert(typeof root === 'string' && path.isAbsolute(root), 'Node.js must support import.meta.dirname')
const output = path.resolve(root, 'target')
const target = process.argv[2] ?? 'all'
assert(process.argv.length <= 3 && ['all', 'psf', 'pcf', 'otb', 'clean'].includes(target), 'Usage: node build.js [all|psf|pcf|otb|clean]')
if (target === 'clean') {
  await fs.rm(output, { recursive: true, force: true })
}
if (target !== 'clean') {
  const files = (await fs.readdir(root)).filter((file) => file.endsWith('.bdf')).sort()
  assert.equal(files.length, 18, 'Expected 18 BDF sources')
  const fonts = await Promise.all(files.map((file) => readFont(path.resolve(root, file))))
  const encodings = fonts[0].glyphs.map((glyph) => glyph.code)
  for (const font of fonts) {
    assert.deepEqual(font.glyphs.map((glyph) => glyph.code), encodings, `Character coverage differs: ${font.profile}`)
    assert.equal(font.properties.get('FONT_VERSION'), fonts[0].properties.get('FONT_VERSION'), `Font version differs: ${font.profile}`)
  }
  const mapping = await readConsoleMapping(root, target)
  await fs.mkdir(output, { recursive: true })
  await fs.copyFile(path.resolve(root, 'LICENSE'), path.resolve(output, 'LICENSE'))
  for (const font of fonts) {
    if (mapping) {
      const slots = consoleSlots(mapping, font.glyphIndex)
      await fs.writeFile(path.resolve(output, `terplus-${font.profile}.psf`), makePsf(font, slots))
    }
    if (target === 'all' || target === 'pcf') {
      await fs.writeFile(path.resolve(output, `terplus-x${font.profile}.pcf`), makePcf(font))
    }
    if (target === 'all' || target === 'otb') {
      await fs.writeFile(path.resolve(output, `terplus-u${font.profile}.otb`), makeOtb(font))
    }
  }
}
