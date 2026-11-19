/** Version compare shared by RUN package listing (extracted M2). */
function splitPrerelease(version: string): [core: string, prerelease: string] {
  // build metadata（`+...`）不参与优先级（semver §11）；先剥再拆预发布，
  // 否则 `1.0.0+build-1` 会被误拆成 core=`1.0.0+build`、pre=`1`。
  const noBuild = version.split('+')[0]
  const i = noBuild.indexOf('-')
  return i < 0 ? [noBuild, ''] : [noBuild.slice(0, i), noBuild.slice(i + 1)]
}

function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number.parseInt(x, 10) : Number.NaN
    const ny = /^\d+$/.test(y) ? Number.parseInt(y, 10) : Number.NaN
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny
    if (!Number.isNaN(nx)) return -1
    if (!Number.isNaN(ny)) return 1
    return x < y ? -1 : 1
  }
  return 0
}

export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = splitPrerelease(a)
  const [bCore, bPre] = splitPrerelease(b)
  const pa = aCore.split('.')
  const pb = bCore.split('.')
  // 非数字段（如 `1.x.0`）不猜测为 0：回退核心串比较，保证确定性。
  if (pa.some((s) => !/^\d+$/.test(s)) || pb.some((s) => !/^\d+$/.test(s))) {
    if (aCore !== bCore) return aCore < bCore ? -1 : 1
  } else {
    const na = pa.map((s) => Number.parseInt(s, 10))
    const nb = pb.map((s) => Number.parseInt(s, 10))
    for (let i = 0; i < Math.max(na.length, nb.length); i += 1) {
      const d = (na[i] ?? 0) - (nb[i] ?? 0)
      if (d !== 0) return d
    }
  }
  if (aPre === bPre) return 0
  if (aPre === '') return 1
  if (bPre === '') return -1
  return comparePrerelease(aPre, bPre)
}
