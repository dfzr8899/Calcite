/**
 * A branch owns its ancestry so sibling embeds can refer to one another.
 * @param {ReadonlySet<string>} ancestors
 * @param {string} path
 * @param {(path: string) => string} key
 * @returns {Set<string>|null}
 */
export function enterEmbed(ancestors,path,key) {
  const id=key(path);
  return ancestors.has(id)?null:new Set([...ancestors,id]);
}
