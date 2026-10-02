// 行为验证入口：用 esbuild 把 TS 测试打成临时 ESM 后用 node 运行。
// 产物写到已被 gitignore 的 .cache/ 下，执行：npm test
import { build } from 'esbuild'

const outfile = '.cache/clearance-test.mjs'
await build({
  entryPoints: ['test/clearance.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})
await import(`../${outfile}?t=${Date.now()}`)
