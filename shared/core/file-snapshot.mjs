/** @typedef {{mtimeMs: number, size: number, hash: string}} FileSnapshot */

/** @param {FileSnapshot|null|undefined} left @param {FileSnapshot|null|undefined} right */
export function sameSnapshot(left,right) {
  return Boolean(left&&right&&left.mtimeMs===right.mtimeMs&&left.size===right.size&&left.hash===right.hash);
}
