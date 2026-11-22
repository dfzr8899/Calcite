const textExtension=/\.(?:md|markdown|mdown|txt|text|json|jsonc|jsonl|ya?ml|canvas|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|java|kt|kts|go|rs|rb|php|sh|bash|ps1|sql|c|cc|cpp|h|hpp|cmake|tex|rst|adoc|properties|editorconfig|gitattributes|gitignore|gitmodules|env)$/i;
const textBasename=/^(?:license|copying|dockerfile|makefile|readme|changelog)$/i;
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const encoder=new TextEncoder();
const binaryControl=/[\x00-\x08\x0b\x0e-\x1f\x7f]/;

export function isTextFile(path) {
  const name=path.split(/[\\/]/).at(-1);
  return textExtension.test(name)||textBasename.test(name);
}

/** @overload @param {string} path @param {string} data @returns {string} */
/** @overload @param {string} path @param {Uint8Array} data @returns {Uint8Array} */
/** @overload @param {string} path @param {unknown} data @returns {unknown} */
/** @param {string} path @param {unknown} data */
export function normalizeLineEndings(path,data) {
  if(!isTextFile(path))return data;
  if(typeof data==='string')return binaryControl.test(data)?data:data.replace(/\r\n?/g,'\n');
  if(!(data instanceof Uint8Array)||!data.includes(13)||data.includes(0))return data;
  try{
    const text=decoder.decode(data);
    return binaryControl.test(text)?data:encoder.encode(text.replace(/\r\n?/g,'\n'));
  }
  catch{return data;}
}
