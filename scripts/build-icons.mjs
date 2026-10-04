import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const svg = readFileSync(join(root, 'resources/brand.svg'), 'utf8')
const output = join(root, 'resources/icons')
mkdirSync(output, { recursive: true })
const png = size => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
writeFileSync(join(output, 'icon.png'), png(1024))
// PNG-backed ICO: Windows supports PNG entries at 256px.
const bitmap = png(256), header = Buffer.alloc(22)
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12)
header.writeUInt32LE(bitmap.length, 14); header.writeUInt32LE(22, 18)
writeFileSync(join(output, 'icon.ico'), Buffer.concat([header, bitmap]))
// An ICNS container with PNG representations, valid on modern macOS.
const entries = [[16,'icp4'],[32,'icp5'],[64,'icp6'],[128,'ic07'],[256,'ic08'],[512,'ic09'],[1024,'ic10']].map(([size,type]) => {
  const data=png(size), chunk=Buffer.alloc(8); chunk.write(type); chunk.writeUInt32BE(data.length+8,4)
  return Buffer.concat([chunk,data])
})
const icns=Buffer.alloc(8);icns.write('icns');icns.writeUInt32BE(8+entries.reduce((sum,e)=>sum+e.length,0),4)
writeFileSync(join(output,'icon.icns'),Buffer.concat([icns,...entries]))
console.log('Generated PNG, ICO and ICNS from resources/brand.svg')
